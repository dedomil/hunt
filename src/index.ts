import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import database from './database';
import { generate } from 'otp-generator';
import { teams, members, coupons } from './database/schema';
import { sendSms } from './services';
import { eq, inArray } from 'drizzle-orm';
import { sign, verify } from 'hono/jwt';
import questions from '../data';
import { authenticate } from './middlewares/authenticate';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('server up'));

app.post(
	'/register',
	zValidator(
		'json',
		z.object({
			name: z.string().max(25),
			phoneNumbers: z.array(z.number().lt(10000000000)).min(2).max(6),
			secretKey: z.string(),
		}),
	),
	async (c) => {
		const db = database(c.env.DB);
		const { name, phoneNumbers, secretKey } = c.req.valid('json');

		if (secretKey != c.env.REGISTER_KEY) {
			return c.text('UNAUTHORIZED', 401);
		}

		const teamId = generate(6, {
			lowerCaseAlphabets: false,
			specialChars: false,
			upperCaseAlphabets: false,
			digits: true,
		});

		try {
			const alreadyPlayedStories = await db
				.select({ story: teams.story })
				.from(teams)
				.fullJoin(members, eq(teams.id, members.team))
				.where(inArray(members.phoneNumber, phoneNumbers));

			const unplayedStories = [1, 2, 3].filter((story) => !alreadyPlayedStories.some((record) => record.story === story));

			if (unplayedStories.length == 0) {
				return c.text('ALREADY PLAYED ALL STORIES');
			}

			const story = unplayedStories[Math.floor(Math.random() * unplayedStories.length)];

			// using batch request to auto rollback if error happens
			await db.batch([
				db.insert(teams).values({ id: teamId, name, story }),
				db.insert(members).values(
					phoneNumbers.map((phoneNumber) => {
						return { team: teamId, phoneNumber };
					}),
				),
			]);

			await sendSms(c, phoneNumbers[0], teamId);

			return c.text('REGISTERED');
		} catch (error) {
			const errorMessage = (error as Error).message;

			if (errorMessage.startsWith('SMSERROR')) {
				await db.batch([db.delete(teams).where(eq(teams.id, teamId)), db.delete(members).where(eq(members.team, teamId))]);
				return c.text('SMSERROR');
			} else {
				return c.text(errorMessage);
			}
		}
	},
);

app.post(
	'/login',
	zValidator(
		'json',
		z.object({
			otp: z.number().lt(1000000),
		}),
	),
	async (c) => {
		const { otp } = c.req.valid('json');
		const db = database(c.env.DB);

		try {
			const team = await db.query.teams.findFirst({
				where: eq(teams.id, `${otp}`),
			});

			if (!team) {
				return c.text('ERROR: WRONG OTP');
			}

			if (!team.startTime) {
				const currentTime = new Date();
				await db
					.update(teams)
					.set({ startTime: currentTime, lastSyncedTime: currentTime })
					.where(eq(teams.id, `${otp}`));
			}

			const token = await sign({ otp }, c.env.REGISTER_KEY);

			return c.json({ token });
		} catch (error) {
			const errorMessage = (error as Error).message;
			return c.text(errorMessage);
		}
	},
);

app.get('/question', authenticate, async (c) => {
	try {
		const { stage, story, phase, startTime, endTime, health } = c.var.data();
		const { answer, ...others } = questions[story - 1][stage - 1][phase - 1];
		return c.json({ ...others, stage, story, phase, startTime, endTime, health }, 200);
	} catch (error) {
		return c.json({ message: 'Internal server error' }, 500);
	}
});

app.post(
	'/question',
	authenticate,
	zValidator(
		'json',
		z.object({
			answer: z.string(),
		}),
	),
	async (c) => {
		try {
			const { otp, story, phase, stage, health } = c.var.data();
			const { answer } = c.req.valid('json');

			const db = database(c.env.DB);

			const currentTime = new Date();
			const correctAnswer = questions[story - 1][stage - 1][phase - 1].answer;

			// answer is wrong, deduct 5 health
			if (correctAnswer.toLowerCase() != answer.toLowerCase()) {
				const newHealth = health - 5 <= 0 ? 0 : health - 5;

				await db
					.update(teams)
					.set({ lastSyncedTime: currentTime, health: newHealth })
					.where(eq(teams.id, `${otp}`));

				return c.json({ message: 'Wrong Answer/Code Scanned' }, 400);
			}

			const newStage = ([1, 3].includes(stage) && phase == 4) || (stage == 2 && phase == 2) ? stage + 1 : stage;
			const newPhase = newStage != stage ? 1 : stage == 4 && phase == 3 ? phase : phase + 1;

			await db
				.update(teams)
				.set({ stage: newStage, phase: newPhase, lastSyncedTime: currentTime, endTime: stage == 4 && phase == 3 ? currentTime : null })
				.where(eq(teams.id, `${otp}`));

			return c.json({ message: 'Correct Answer!' }, 200);
		} catch (error) {
			return c.json({ message: 'Internal server error' }, 500);
		}
	},
);

app.post(
	'/refuel',
	authenticate,
	zValidator(
		'json',
		z.object({
			coupon: z.string(),
		}),
	),
	async (c) => {
		try {
			const { otp } = c.var.data();
			const { coupon } = c.req.valid('json');

			const db = database(c.env.DB);

			const couponDetails = await db.query.coupons.findFirst({ where: eq(coupons.data, coupon) });
			if (!couponDetails) return c.json({ message: 'invalid coupon code' }, 400);
			if (couponDetails.isUsed) return c.json({ message: 'coupon already used' }, 400);

			const teamDetails = await db.query.teams.findFirst({ where: eq(teams.id, `${otp}`) });
			if (!teamDetails) return c.json({ message: 'wrong otp entered' }, 422);
			if (teamDetails.isRestored) return c.json({ message: 'repair only once!' });

			const newHealth = teamDetails.health + 40 >= 100 ? 100 : teamDetails.health + 40;

			await db.batch([
				db
					.update(teams)
					.set({ health: newHealth, isRestored: true }) // sync?
					.where(eq(teams.id, `${otp}`)),
				db.update(coupons).set({ isUsed: true }).where(eq(coupons.data, coupon)),
			]);

			return c.json({ message: 'Ship Health Restored!!' });
		} catch (error) {
			const errorMessage = (error as Error).message;
			return c.text(errorMessage);
		}
	},
);

export default app;
