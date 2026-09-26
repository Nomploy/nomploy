import { db } from "@nomploy/server/db";
import {
	alertRule,
	apiCreateAlertRule,
	apiUpdateAlertRule,
} from "@nomploy/server/db/schema";
import {
	AVAILABLE_METRICS,
	listAlertEvents,
} from "@nomploy/server/services/alerts";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";

export const alertRouter = createTRPCRouter({
	// Catalogue of alertable metrics for the rule editor.
	metrics: withPermission("monitoring", "read").query(() => AVAILABLE_METRICS),

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
});
