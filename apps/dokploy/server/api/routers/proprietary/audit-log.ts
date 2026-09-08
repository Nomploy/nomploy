/**
 * nomploy — original (Apache/AGPL) audit-log router. Reads audit entries for the
 * caller's active organization, with optional filters + pagination. Original
 * nomploy code (no upstream enterprise/DSAL code reused).
 */
import { getAuditLogs } from "@nomploy/server/services/proprietary/audit-log";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../../trpc";

export const auditLogRouter = createTRPCRouter({
	all: protectedProcedure
		.input(
			z
				.object({
					userEmail: z.string().optional(),
					resourceName: z.string().optional(),
					action: z.string().optional(),
					resourceType: z.string().optional(),
					from: z.string().datetime().optional(),
					to: z.string().datetime().optional(),
					limit: z.number().int().min(1).max(200).optional(),
					offset: z.number().int().min(0).optional(),
				})
				.optional(),
		)
		.query(async ({ ctx, input }) => {
			const organizationId = ctx.session?.activeOrganizationId;
			if (!organizationId) throw new TRPCError({ code: "UNAUTHORIZED" });
			return getAuditLogs({
				organizationId,
				userEmail: input?.userEmail,
				resourceName: input?.resourceName,
				// biome-ignore lint/suspicious/noExplicitAny: filters are validated by the service's typed union
				action: input?.action as any,
				// biome-ignore lint/suspicious/noExplicitAny: filters are validated by the service's typed union
				resourceType: input?.resourceType as any,
				from: input?.from ? new Date(input.from) : undefined,
				to: input?.to ? new Date(input.to) : undefined,
				limit: input?.limit,
				offset: input?.offset,
			});
		}),
});
