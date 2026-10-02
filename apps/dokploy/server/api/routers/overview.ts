import {
	findAllBackupsCentralized,
	findAllDomainsCentralized,
	findAllServicesCentralized,
} from "@nomploy/server/services/overview";
import { findMemberByUserId } from "@nomploy/server/services/permission";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";

// Owner/admin see the whole org (null); members are scoped to accessedServices.
const resolveAccess = async (ctx: {
	user: { id: string; role: string };
	session: { activeOrganizationId: string };
}): Promise<string[] | null> => {
	const orgId = ctx.session.activeOrganizationId;
	return ctx.user.role !== "owner" && ctx.user.role !== "admin"
		? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
		: null;
};

export const overviewRouter = createTRPCRouter({
	services: withPermission("service", "read").query(async ({ ctx }) =>
		findAllServicesCentralized(
			ctx.session.activeOrganizationId,
			await resolveAccess(ctx),
		),
	),

	domains: withPermission("domain", "read").query(async ({ ctx }) =>
		findAllDomainsCentralized(
			ctx.session.activeOrganizationId,
			await resolveAccess(ctx),
		),
	),

	backups: withPermission("backup", "read").query(async ({ ctx }) =>
		findAllBackupsCentralized(
			ctx.session.activeOrganizationId,
			await resolveAccess(ctx),
		),
	),
});
