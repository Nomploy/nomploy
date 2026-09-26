import { relations } from "drizzle-orm";
import {
	boolean,
	doublePrecision,
	index,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";

/** Metrics an alert rule can watch. Each maps to a provider in services/alerts.ts. */
export const ALERT_METRICS = [
	"lb_5xx_per_sec",
	"lb_req_per_sec",
	"lb_latency_ms",
	"service_cpu_pct",
	"service_mem_pct",
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

/** Whether a service-scoped metric needs a `target` (the Nomad job / appName). */
export const metricNeedsTarget = (m: string): boolean =>
	m.startsWith("service_");

/**
 * A user-defined alert rule: watch a metric, and when it stays over/under a
 * threshold for `forMinutes`, fire (and later resolve) — notifying every channel
 * that has "cluster alerts" enabled. Evaluated by the alert loop against the
 * rolling metric samples. `state` holds the current firing/ok status so the loop
 * only notifies on transitions.
 */
export const alertRule = pgTable("alert_rule", {
	alertRuleId: text("alertRuleId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	metric: text("metric").notNull(),
	// Service metrics scope to a Nomad job id (appName); pool metrics are global.
	target: text("target"),
	comparator: text("comparator").notNull().default("gt"), // "gt" | "lt"
	threshold: doublePrecision("threshold").notNull(),
	forMinutes: integer("forMinutes").notNull().default(5),
	enabled: boolean("enabled").notNull().default(true),
	state: text("state").notNull().default("ok"), // "ok" | "firing"
	lastValue: doublePrecision("lastValue"),
	lastStateChangeAt: timestamp("lastStateChangeAt"),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const alertEvent = pgTable(
	"alert_event",
	{
		alertEventId: text("alertEventId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		alertRuleId: text("alertRuleId")
			.notNull()
			.references(() => alertRule.alertRuleId, { onDelete: "cascade" }),
		type: text("type").notNull(), // "fired" | "resolved"
		value: doublePrecision("value").notNull().default(0),
		message: text("message").notNull().default(""),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(t) => ({
		orgCreatedIdx: index("alert_event_org_created_idx").on(
			t.organizationId,
			t.createdAt,
		),
	}),
);

export const alertRuleRelations = relations(alertRule, ({ one, many }) => ({
	organization: one(organization, {
		fields: [alertRule.organizationId],
		references: [organization.id],
	}),
	events: many(alertEvent),
}));

export const alertEventRelations = relations(alertEvent, ({ one }) => ({
	rule: one(alertRule, {
		fields: [alertEvent.alertRuleId],
		references: [alertRule.alertRuleId],
	}),
}));

const createSchema = createInsertSchema(alertRule, {
	name: z.string().min(1),
	metric: z.enum(ALERT_METRICS),
	comparator: z.enum(["gt", "lt"]),
	threshold: z.number(),
	forMinutes: z.number().int().min(1).max(1440),
});

export const apiCreateAlertRule = createSchema
	.pick({
		name: true,
		metric: true,
		target: true,
		comparator: true,
		threshold: true,
		forMinutes: true,
		enabled: true,
	})
	.extend({ target: z.string().optional().nullable() });

export const apiUpdateAlertRule = apiCreateAlertRule.partial().extend({
	alertRuleId: z.string().min(1),
});

export type AlertRule = typeof alertRule.$inferSelect;
