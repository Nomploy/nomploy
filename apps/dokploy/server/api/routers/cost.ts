import {
	computeCostReport,
	getCostConfig,
	getCostHistory,
	getCostSpend,
	getProjectCostHistory,
	setCostConfig,
	suggestHetznerPrices,
} from "@nomploy/server/services/cost";
import { findMemberByUserId } from "@nomploy/server/services/permission";
import { applyAllSafeReductions } from "@nomploy/server/services/rightsize";
import { getCostOptimization } from "@nomploy/server/services/scaling-suggestions";
import { z } from "zod";
import { adminProcedure, createTRPCRouter, withPermission } from "@/server/api/trpc";

// Owner/admin see the whole org (null); members are scoped to accessedServices —
// same access model the Overview uses for the per-service rollup.
const resolveAccess = async (ctx: {
	user: { id: string; role: string };
	session: { activeOrganizationId: string };
}): Promise<string[] | null> => {
	const orgId = ctx.session.activeOrganizationId;
	return ctx.user.role !== "owner" && ctx.user.role !== "admin"
		? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
		: null;
};

export const costRouter = createTRPCRouter({
	report: withPermission("service", "read").query(async ({ ctx }) =>
		computeCostReport(
			ctx.session.activeOrganizationId,
			await resolveAccess(ctx),
		),
	),

	getConfig: adminProcedure.query(() => getCostConfig()),

	// Month-to-date spend + end-of-month projection vs the budget.
	spend: withPermission("service", "read").query(async ({ ctx }) =>
		getCostSpend(ctx.session.activeOrganizationId),
	),

	// Optimization summary: potential savings, score, scale-to-zero adoption.
	optimization: withPermission("service", "read").query(async ({ ctx }) =>
		getCostOptimization(ctx.session.activeOrganizationId),
	),

	// Bulk-apply all safe (zero-downtime application) reductions.
	applyAllReductions: adminProcedure.mutation(async ({ ctx }) =>
		applyAllSafeReductions(ctx.session.activeOrganizationId),
	),

	saveConfig: adminProcedure
		.input(
			z.object({
				currency: z.string().optional(),
				typePrices: z.record(z.string(), z.number()).optional(),
				nodePrices: z.record(z.string(), z.number()).optional(),
				monthlyBudget: z.number().min(0).optional(),
			}),
		)
		.mutation(({ input }) => {
			const prev = getCostConfig();
			return setCostConfig({
				currency: input.currency ?? prev.currency,
				typePrices: input.typePrices ?? prev.typePrices,
				nodePrices: input.nodePrices ?? prev.nodePrices,
				monthlyBudget: input.monthlyBudget ?? prev.monthlyBudget,
			});
		}),

	suggestPrices: adminProcedure.query(({ ctx }) =>
		suggestHetznerPrices(ctx.session.activeOrganizationId),
	),

	// Cluster run-rate history (stacked allocated / platform / idle) for the chart.
	history: withPermission("service", "read")
		.input(
			z.object({
				minutes: z.number().int().min(5).max(43200).default(1440),
			}),
		)
		.query(async ({ ctx, input }) =>
			getCostHistory(ctx.session.activeOrganizationId, input.minutes),
		),

	// Per-project cost history (all projects) for a multi-line chart.
	projectHistory: withPermission("service", "read")
		.input(
			z.object({ minutes: z.number().int().min(5).max(43200).default(1440) }),
		)
		.query(async ({ ctx, input }) =>
			getProjectCostHistory(ctx.session.activeOrganizationId, input.minutes),
		),

	// Projects that have cost history — targets for a cost_project_monthly alert /
	// the Metrics dashboard's project picker. Derived from the report's rollup.
	projectTargets: withPermission("service", "read").query(async ({ ctx }) => {
		const report = await computeCostReport(
			ctx.session.activeOrganizationId,
			await resolveAccess(ctx),
		);
		return report.projects.map((p) => ({
			projectId: p.projectId,
			projectName: p.projectName,
		}));
	}),
});
