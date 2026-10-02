import { relations } from "drizzle-orm";
import {
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
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
 * Sentinel `target` for a service-metric rule that watches EVERY service
 * (SigNoz-style) — the loop fans out over all services and fires/resolves each
 * independently, tracking per-service status in {@link alertRule.seriesState}.
 */
export const ALERT_ALL_TARGETS = "__all__";

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
	severity: text("severity").notNull().default("warning"), // "critical" | "warning" | "info"
	forMinutes: integer("forMinutes").notNull().default(5),
	enabled: boolean("enabled").notNull().default(true),
	state: text("state").notNull().default("ok"), // "ok" | "firing" (aggregate for all-targets)
	// Per-service firing/ok status for an "all services" rule (target=__all__),
	// so each service transitions independently. Null for single-target rules.
	seriesState: jsonb("seriesState").$type<Record<string, "firing" | "ok">>(),
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
		// True when an active silence suppressed this transition's notification.
		silenced: boolean("silenced").notNull().default(false),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(t) => ({
		orgCreatedIdx: index("alert_event_org_created_idx").on(
			t.organizationId,
			t.createdAt,
		),
	}),
);

/**
 * A silence / maintenance window: suppress alert NOTIFICATIONS for the
 * [startsAt, endsAt] window. Rules still evaluate and transition (the UI shows
 * them firing), but matching fired/resolved transitions don't notify. A silence
 * matches a transition when every non-null matcher matches — so an empty-matcher
 * silence is an org-wide maintenance window, while setting `alertRuleId` /
 * `target` / `severity` narrows it to one rule, one service, or one severity.
 */
export const alertSilence = pgTable(
	"alert_silence",
	{
		silenceId: text("silenceId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		comment: text("comment").notNull().default(""),
		// For a one-shot silence: the active window. For a RECURRING one (maintenance
		// window): the overall validity bounds — the daily window recurs between these.
		startsAt: timestamp("startsAt").notNull().defaultNow(),
		endsAt: timestamp("endsAt").notNull(),
		// Recurring (maintenance window) — a daily window [recurStartMinute,
		// recurEndMinute) in UTC minutes-from-midnight, on recurDays weekdays (0=Sun..
		// 6=Sat; empty/null = every day), repeating between startsAt and endsAt.
		recurring: boolean("recurring").notNull().default(false),
		recurStartMinute: integer("recurStartMinute"),
		recurEndMinute: integer("recurEndMinute"),
		recurDays: integer("recurDays").array(),
		// Matchers (null = match any).
		alertRuleId: text("alertRuleId").references(() => alertRule.alertRuleId, {
			onDelete: "cascade",
		}),
		target: text("target"), // service appName
		severity: text("severity"), // "critical" | "warning" | "info"
		createdBy: text("createdBy"),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(t) => ({
		orgEndsIdx: index("alert_silence_org_ends_idx").on(
			t.organizationId,
			t.endsAt,
		),
	}),
);

export const alertSilenceRelations = relations(alertSilence, ({ one }) => ({
	organization: one(organization, {
		fields: [alertSilence.organizationId],
		references: [organization.id],
	}),
	rule: one(alertRule, {
		fields: [alertSilence.alertRuleId],
		references: [alertRule.alertRuleId],
	}),
}));

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
	severity: z.enum(["critical", "warning", "info"]),
	forMinutes: z.number().int().min(1).max(1440),
});

export const apiCreateAlertRule = createSchema
	.pick({
		name: true,
		metric: true,
		target: true,
		comparator: true,
		threshold: true,
		severity: true,
		forMinutes: true,
		enabled: true,
	})
	.extend({
		target: z.string().optional().nullable(),
		severity: z.enum(["critical", "warning", "info"]).optional(),
	});

export const apiUpdateAlertRule = apiCreateAlertRule.partial().extend({
	alertRuleId: z.string().min(1),
});

export type AlertRule = typeof alertRule.$inferSelect;

// Create a silence. `startsAt` defaults to now (immediate); `endsAt` is required.
// The UI computes `endsAt` from a duration preset or a custom date (scheduled
// maintenance). Matchers are all optional (omitted = org-wide).
export const apiCreateAlertSilence = z
	.object({
		comment: z.string().trim().min(1, "Add a reason for the silence"),
		startsAt: z.string().datetime().optional(),
		endsAt: z.string().datetime(),
		alertRuleId: z.string().optional().nullable(),
		target: z.string().optional().nullable(),
		severity: z.enum(["critical", "warning", "info"]).optional().nullable(),
		// Recurring maintenance window: a daily [recurStartMinute, recurEndMinute)
		// UTC window on recurDays (0=Sun..6=Sat; empty = every day). startsAt/endsAt
		// then bound the overall recurrence span.
		recurring: z.boolean().optional(),
		recurStartMinute: z.number().int().min(0).max(1439).optional().nullable(),
		recurEndMinute: z.number().int().min(1).max(1440).optional().nullable(),
		recurDays: z.array(z.number().int().min(0).max(6)).optional().nullable(),
	})
	.refine(
		(v) =>
			!v.recurring ||
			(v.recurStartMinute != null &&
				v.recurEndMinute != null &&
				v.recurEndMinute > v.recurStartMinute),
		{
			message:
				"A recurring window needs an end time after its start time (same day).",
			path: ["recurEndMinute"],
		},
	);

export type AlertSilence = typeof alertSilence.$inferSelect;
