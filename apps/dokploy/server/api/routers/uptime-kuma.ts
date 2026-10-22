import {
	connectUptimeKuma,
	getUptimeKuma,
	getUptimeKumaStatus,
	removeUptimeKuma,
	syncUptimeKumaMonitors,
	updateUptimeKumaSettings,
} from "@nomploy/server";
import { TRPCError } from "@trpc/server";
import { audit } from "@/server/api/utils/audit";
import { apiConnectUptimeKuma, apiUpdateUptimeKuma } from "@/server/db/schema";
import { createTRPCRouter, withPermission } from "../trpc";

export const uptimeKumaRouter = createTRPCRouter({
	get: withPermission("server", "read").query(async ({ ctx }) =>
		getUptimeKuma(ctx.session.activeOrganizationId),
	),
	status: withPermission("server", "read").query(async ({ ctx }) =>
		getUptimeKumaStatus(ctx.session.activeOrganizationId),
	),
	connect: withPermission("server", "create")
		.input(apiConnectUptimeKuma)
		.mutation(async ({ ctx, input }) => {
			try {
				const res = await connectUptimeKuma(
					ctx.session.activeOrganizationId,
					input,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "server",
					resourceId: ctx.session.activeOrganizationId,
					resourceName: "Uptime Kuma",
				});
				// First sync in the background so the mutation returns fast.
				void syncUptimeKumaMonitors(ctx.session.activeOrganizationId).catch(
					() => {},
				);
				return res;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Failed to connect to Uptime Kuma",
				});
			}
		}),
	update: withPermission("server", "create")
		.input(apiUpdateUptimeKuma)
		.mutation(async ({ ctx, input }) => {
			await updateUptimeKumaSettings(ctx.session.activeOrganizationId, input);
			if (input.autoMonitor || input.enabled) {
				void syncUptimeKumaMonitors(ctx.session.activeOrganizationId).catch(
					() => {},
				);
			}
			return { ok: true };
		}),
	syncNow: withPermission("server", "create").mutation(async ({ ctx }) => {
		try {
			const res = await syncUptimeKumaMonitors(
				ctx.session.activeOrganizationId,
			);
			if (!res)
				throw new Error("Uptime Kuma is not enabled or auto-monitor is off");
			return res;
		} catch (error) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: error instanceof Error ? error.message : "Sync failed",
			});
		}
	}),
	remove: withPermission("server", "delete").mutation(async ({ ctx }) => {
		await removeUptimeKuma(ctx.session.activeOrganizationId);
		await audit(ctx, {
			action: "delete",
			resourceType: "server",
			resourceId: ctx.session.activeOrganizationId,
			resourceName: "Uptime Kuma",
		});
		return { ok: true };
	}),
});
