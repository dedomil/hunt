import { relations } from 'drizzle-orm';
import { sqliteTable, integer, real, text, primaryKey } from 'drizzle-orm/sqlite-core';

export const teams = sqliteTable('teams', {
	id: text('id').primaryKey(),
	name: text('name', { length: 25 }).unique().notNull(),
	story: integer('story').notNull(),
	stage: integer('stage').notNull().default(1),
	phase: integer('phase').notNull().default(1),
	health: real('health').notNull().default(100),
	isRestored: integer('is_restored', { mode: 'boolean' }).notNull().default(false),
	finalQuestion: text('final_question'),
	startTime: integer('start_time', { mode: 'timestamp_ms' }), // note startTime on first login
	endTime: integer('end_time', { mode: 'timestamp_ms' }), // note endTime on winning
	lastSyncedTime: integer('last_synced_time', { mode: 'timestamp_ms' }),
});

export const members = sqliteTable(
	'members',
	{
		phoneNumber: integer('phone_number').notNull(),
		team: text('team').notNull(),
	},
	(table) => {
		return [primaryKey({ columns: [table.team, table.phoneNumber] })];
	},
);

export const coupons = sqliteTable('coupons', {
	data: text('data').primaryKey(),
	isUsed: integer('is_used', { mode: 'boolean' }).default(false),
});

export const teamRelations = relations(teams, ({ many }) => ({
	phoneNumbers: many(members),
}));

export const memberRelations = relations(members, ({ one }) => ({
	team: one(teams, {
		fields: [members.team],
		references: [teams.id],
	}),
}));
