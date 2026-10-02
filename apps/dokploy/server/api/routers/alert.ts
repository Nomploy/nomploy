import { db } from "@nomploy/server/db";
import {
	alertRule,
	alertSilence,
	apiCreateAlertRule,
	apiCreateAlertSilence,
	apiUpdateAlertRule,
} from "@nomploy/server/db/schema";
import {
	AVAILABLE_METRICS,
	getMetricHistory,
	listAlertEvents,
	listAlertSilences,
	listAlertTargets,
} from "@nomploy/server/services/alerts";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";

export const alertRouter = createTRPCRouter({
	// Catalogue of alertable metrics for the rule editor.
	metrics: withPermission("monitoring", "read").query(() => AVAILABLE_METRICS),

	// Services (appName targets) for service-scoped metric rules.
	targets: withPermission("monitoring", "read").query(async ({ ctx }) =>
		listAlertTargets(ctx.session.activeOrganizationId),
	),

	// Time series for a metric (rule editor preview chart + per-rule graphs).
	metricHistory: withPermission("monitoring", "read")
		.input(
			z.object({
				metric: z.string(),
				target: z.string().nullable().optional(),
				minutes: z.number().int().min(5).max(1440).default(360),
			}),
		)
		.query(async ({ ctx, input }) =>
			getMetricHistory(
				ctx.session.activeOrganizationId,
				input.metric,
				input.target ?? null,
				input.minutes,
			),
		),

	list: withPermission("monitoring", "read").query(async ({ ctx }) =>
		db.query.alertRule.findMany({
			where: eq(alertRule.organizationId, ctx.session.activeOrganizationId),
			orderBy: desc(alertRule.createdAt),
		}),
	),

	events: withPermission("monitoring", "read")
		.input(z.object({ limit: z.number().int().min(1).max(200).optional() }))
		.query(async ({ ctx, input }) =>
			listAlertEvents(ctx.session.activeOrganizationId, input.limit ?? 50),
		),

	create: withPermission("server", "create")
		.input(apiCreateAlertRule)
		.mutation(async ({ ctx, input }) => {
			const [row] = await db
				.insert(alertRule)
				.values({
					organizationId: ctx.session.activeOrganizationId,
					name: input.name,
					metric: input.metric,
					target: input.target ?? null,
					comparator: input.comparator,
					threshold: input.threshold,
					severity: input.severity ?? "warning",
					forMinutes: input.forMinutes,
					enabled: input.enabled ?? true,
				})
				.returning();
			return row;
		}),

	update: withPermission("server", "create")
		.input(apiUpdateAlertRule)
		.mutation(async ({ ctx, input }) => {
			const { alertRuleId, ...rest } = input;
			const existing = await db.query.alertRule.findFirst({
				where: and(
					eq(alertRule.alertRuleId, alertRuleId),
					eq(alertRule.organizationId, ctx.session.activeOrganizationId),
				),
			});
			if (!existing)
				throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found" });
			await db
				.update(alertRule)
				.set({
					...rest,
					target: rest.target ?? existing.target,
					// A config change clears the current state so it re-evaluates cleanly.
					state: "ok",
				})
				.where(eq(alertRule.alertRuleId, alertRuleId));
			return true;
		}),

	setEnabled: withPermission("server", "create")
		.input(z.object({ alertRuleId: z.string(), enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			await db
				.update(alertRule)
				.set({ enabled: input.enabled, state: "ok" })
				.where(
					and(
						eq(alertRule.alertRuleId, input.alertRuleId),
						eq(alertRule.organizationId, ctx.session.activeOrganizationId),
					),
				);
			return true;
		}),

	delete: withPermission("server", "delete")
		.input(z.object({ alertRuleId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await db
				.delete(alertRule)
				.where(
					and(
						eq(alertRule.alertRuleId, input.alertRuleId),
						eq(alertRule.organizationId, ctx.session.activeOrganizationId),
					),
				);
			return true;
		}),

	// ── Silences / maintenance windows ─────────────────────────────────────────
	// Suppress alert NOTIFICATIONS for a time window (rules still evaluate).
	silences: withPermission("monitoring", "read").query(async ({ ctx }) =>
		listAlertSilences(ctx.session.activeOrganizationId),
	),

	createSilence: withPermission("server", "create")
		.input(apiCreateAlertSilence)
		.mutation(async ({ ctx, input }) => {
			const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
			const endsAt = new Date(input.endsAt);
			if (endsAt <= startsAt)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The silence must end after it starts.",
				});
			// A rule-scoped silence must belong to this org.
			if (input.alertRuleId) {
				const rule = await db.query.alertRule.findFirst({
					where: and(
						eq(alertRule.alertRuleId, input.alertRuleId),
						eq(alertRule.organizationId, ctx.session.activeOrganizationId),
					),
				});
				if (!rule)
					throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found" });
			}
			const [row] = await db
				.insert(alertSilence)
				.values({
					organizationId: ctx.session.activeOrganizationId,
					comment: input.comment,
					startsAt,
					endsAt,
					recurring: input.recurring ?? false,
					recurStartMinute: input.recurring
						? (input.recurStartMinute ?? null)
						: null,
					recurEndMinute: input.recurring
						? (input.recurEndMinute ?? null)
						: null,
					recurDays: input.recurring ? (input.recurDays ?? []) : null,
					alertRuleId: input.alertRuleId ?? null,
					target: input.target ?? null,
					severity: input.severity ?? null,
					createdBy: ctx.user?.email ?? null,
				})
				.returning();
			return row;
		}),

	// Delete a scheduled/active silence, or end an active one early (endsAt=now).
	deleteSilence: withPermission("server", "create")
		.input(z.object({ silenceId: z.string(), endNow: z.boolean().optional() }))
		.mutation(async ({ ctx, input }) => {
			const where = and(
				eq(alertSilence.silenceId, input.silenceId),
				eq(alertSilence.organizationId, ctx.session.activeOrganizationId),
			);
			if (input.endNow) {
				await db.update(alertSilence).set({ endsAt: new Date() }).where(where);
			} else {
				await db.delete(alertSilence).where(where);
			}
			return true;
		}),
});
