import { zValidator } from '@hono/zod-validator';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sign } from 'hono/jwt';
import { generate } from 'otp-generator';
import { z } from 'zod';
import questions from '../data';
import database from './database';
import { coupons, members, teams } from './database/schema';
import { authenticate } from './middlewares/authenticate';
import { sendSms } from './services';

const app = new Hono<{ Bindings: Env }>();

app.use(cors());

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
			return c.json({ message: 'unauthorized' }, 403);
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
				return c.json({ message: 'team already played all stories' }, 422);
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

			return c.json({ message: 'registered' }, 200);
		} catch (error) {
			const errorMessage = (error as Error).message;

			if (errorMessage.startsWith('SMSERROR')) {
				await db.batch([db.delete(teams).where(eq(teams.id, teamId)), db.delete(members).where(eq(members.team, teamId))]);
				return c.json({ message: 'sms error' }, 500);
			} else {
				return c.json({ message: 'internal server error' }, 500);
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
				return c.json({ message: 'wrong otp entered' }, 422);
			}

			if (!team.startTime) {
				const currentTime = new Date();
				await db
					.update(teams)
					.set({ startTime: currentTime, lastSyncedTime: currentTime })
					.where(eq(teams.id, `${otp}`));
			}

			const token = await sign({ otp }, c.env.REGISTER_KEY);

			return c.json({ token }, 200);
		} catch (error) {
			const errorMessage = (error as Error).message;
			return c.json({ message: errorMessage }, 500);
		}
	},
);

app.get('/question', authenticate, async (c) => {
	try {
		const { stage, story, phase, startTime, endTime, health } = c.var.data();
		const { answer, ...others } = questions[story - 1][stage - 1][phase - 1];
		return c.json({ ...others, stage, story, phase, startTime, endTime, health }, 200);
	} catch (error) {
		return c.json({ message: 'internal server error' }, 500);
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

				return c.json({ message: 'wrong answer or qr scanned' }, 400);
			}

			const newStage = ([1, 3].includes(stage) && phase == 4) || (stage == 2 && phase == 2) ? stage + 1 : stage;
			const newPhase = newStage != stage ? 1 : stage == 4 && phase == 3 ? phase : phase + 1;

			await db
				.update(teams)
				.set({ stage: newStage, phase: newPhase, lastSyncedTime: currentTime, endTime: stage == 4 && phase == 3 ? currentTime : null })
				.where(eq(teams.id, `${otp}`));

			return c.json({ message: 'correct answer!' }, 200);
		} catch (error) {
			return c.json({ message: 'internal server error' }, 500);
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
			if (!couponDetails) return c.json({ message: 'invalid coupon code' }, 422);
			if (couponDetails.isUsed) return c.json({ message: 'coupon already used' }, 422);

			const teamDetails = await db.query.teams.findFirst({ where: eq(teams.id, `${otp}`) });
			if (!teamDetails) return c.json({ message: 'wrong otp entered' }, 422);
			if (teamDetails.isRestored) return c.json({ message: 'already restored' }, 422);

			const newHealth = teamDetails.health + 40 >= 100 ? 100 : teamDetails.health + 40;

			await db.batch([
				db
					.update(teams)
					.set({ health: newHealth, isRestored: true }) // sync?
					.where(eq(teams.id, `${otp}`)),
				db.update(coupons).set({ isUsed: true }).where(eq(coupons.data, coupon)),
			]);

			return c.json({ message: 'health restored' }, 200);
		} catch (error) {
			const errorMessage = (error as Error).message;
			return c.json({ message: errorMessage }, 500);
		}
	},
);

export default app;
