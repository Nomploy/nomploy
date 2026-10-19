import {
	computeCostReport,
	getCostConfig,
	getCostHistory,
	setCostConfig,
	suggestHetznerPrices,
} from "@nomploy/server/services/cost";
import { findMemberByUserId } from "@nomploy/server/services/permission";
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

	saveConfig: adminProcedure
		.input(
			z.object({
				currency: z.string().optional(),
				typePrices: z.record(z.string(), z.number()).optional(),
				nodePrices: z.record(z.string(), z.number()).optional(),
			}),
		)
		.mutation(({ input }) => {
			const prev = getCostConfig();
			return setCostConfig({
				currency: input.currency ?? prev.currency,
				typePrices: input.typePrices ?? prev.typePrices,
				nodePrices: input.nodePrices ?? prev.nodePrices,
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
