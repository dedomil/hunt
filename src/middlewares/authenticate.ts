import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import database from '../database';
import { teams } from '../database/schema';

export type Data = {
	otp: number;
	story: number;
	stage: number;
	phase: number;
	endTime: Date | null;
	startTime: Date | null;
	lastSyncedTime: Date;
	health: number;
};

export const authenticate = createMiddleware<{ Bindings: Env; Variables: { data: () => Data } }>(async (c, next) => {
	const token = c.req.header('Authorization')?.split(' ')?.[1];
	if (!token) return c.json({ message: 'wrong otp entered' }, 401);

	try {
		const verifiedPayload = await verify(token, c.env.REGISTER_KEY);
		const otp = verifiedPayload?.otp;
		const db = database(c.env.DB);

		const teamDetails = await db.query.teams.findFirst({ where: eq(teams.id, `${otp}`) });

		if (!teamDetails) return c.json({ message: 'wrong otp entered' }, 401);
		if (teamDetails.endTime) return c.json({ message: 'yay! you completed the quest!', type: 4 }, 418);
		if (!teamDetails.startTime || !teamDetails.lastSyncedTime) return c.json({ message: 'please login again!', type: 4 }, 401);
		if (teamDetails.lastSyncedTime.getTime() > teamDetails.startTime.getTime() + 1800000)
			return c.json({ message: 'health is zero 1', type: 5 }, 422); // update db?

		const currentTime = new Date();
		const healthLostInBetween = ((currentTime.getTime() - teamDetails.lastSyncedTime.getTime()) / 1000) * 0.025;
		const newHealth = teamDetails.health - healthLostInBetween;

		if (newHealth <= 0) {
			if (teamDetails.health != 0)
				await db
					.update(teams)
					.set({ health: 0, lastSyncedTime: currentTime })
					.where(eq(teams.id, `${otp}`));
			return c.json({ message: 'health is zero! 2', type: 5 }, 422);
		} else {
			await db
				.update(teams)
				.set({ health: newHealth, lastSyncedTime: currentTime })
				.where(eq(teams.id, `${otp}`));

			c.set('data', () => {
				return {
					otp: otp as number,
					story: teamDetails.story,
					stage: teamDetails.stage,
					phase: teamDetails.phase,
					endTime: teamDetails.endTime,
					startTime: teamDetails.startTime,
					lastSyncedTime: currentTime,
					health: newHealth,
				};
			});

			return next();
		}
	} catch (error) {
		return c.json({ message: 'couldnt authenticate' }, 401);
	}
});
