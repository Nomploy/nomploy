import { db } from "@nomploy/server/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateCloudProvider,
	apiFindOneCloudProvider,
	apiRemoveCloudProvider,
	apiTestCloudProvider,
	apiUpdateCloudProvider,
	cloudProvider,
	clusterAutoscaler,
} from "@/server/db/schema";

/** Validate a provider token against the vendor API. Throws on failure. */
const testProviderToken = async (
	provider: string,
	token: string,
): Promise<{ ok: true; detail: string }> => {
	if (!token) throw new Error("No token provided");
	if (provider === "hetzner") {
		const res = await fetch("https://api.hetzner.cloud/v1/locations", {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (res.status === 401 || res.status === 403)
			throw new Error("Invalid or unauthorized token");
		if (!res.ok) throw new Error(`Hetzner API error ${res.status}`);
		const data = (await res.json()) as { locations?: { name: string }[] };
		const locs = (data.locations || []).map((l) => l.name).join(", ");
		return { ok: true, detail: `Token valid. Locations: ${locs || "none"}` };
	}
	throw new Error(`Unsupported provider: ${provider}`);
};

// Strip the token from a row before returning it; expose only whether one is set.
const mask = <T extends { token: string }>(row: T) => {
	const { token, ...rest } = row;
	return { ...rest, hasToken: !!token };
};

export const cloudProviderRouter = createTRPCRouter({
	all: withPermission("server", "read").query(async ({ ctx }) => {
		const rows = await db.query.cloudProvider.findMany({
			where: eq(cloudProvider.organizationId, ctx.session.activeOrganizationId),
			orderBy: desc(cloudProvider.createdAt),
		});
		return rows.map(mask);
	}),

	one: withPermission("server", "read")
		.input(apiFindOneCloudProvider)
		.query(async ({ input, ctx }) => {
			const row = await db.query.cloudProvider.findFirst({
				where: and(
					eq(cloudProvider.cloudProviderId, input.cloudProviderId),
					eq(cloudProvider.organizationId, ctx.session.activeOrganizationId),
				),
			});
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			return mask(row);
		}),

	create: withPermission("server", "create")
		.input(apiCreateCloudProvider)
		.mutation(async ({ input, ctx }) => {
			const [row] = await db
				.insert(cloudProvider)
				.values({
					name: input.name,
					provider: input.provider,
					token: input.token,
					sshKeyId: input.sshKeyId || null,
					organizationId: ctx.session.activeOrganizationId,
				})
				.returning();
			if (!row)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the cloud provider",
				});
			await audit(ctx, {
				action: "create",
				resourceType: "cloudProvider",
				resourceId: row.cloudProviderId,
				resourceName: input.name,
			});
			return mask(row);
		}),

	update: withPermission("server", "create")
		.input(apiUpdateCloudProvider)
		.mutation(async ({ input, ctx }) => {
			const existing = await db.query.cloudProvider.findFirst({
				where: and(
					eq(cloudProvider.cloudProviderId, input.cloudProviderId),
					eq(cloudProvider.organizationId, ctx.session.activeOrganizationId),
				),
			});
			if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
			const [row] = await db
				.update(cloudProvider)
				.set({
					...(input.name !== undefined ? { name: input.name } : {}),
					...(input.provider !== undefined ? { provider: input.provider } : {}),
					...(input.sshKeyId !== undefined
						? { sshKeyId: input.sshKeyId || null }
						: {}),
					// Only overwrite the token when a non-empty one is provided.
					...(input.token ? { token: input.token } : {}),
				})
				.where(eq(cloudProvider.cloudProviderId, input.cloudProviderId))
				.returning();
			await audit(ctx, {
				action: "update",
				resourceType: "cloudProvider",
				resourceId: input.cloudProviderId,
				resourceName: row?.name ?? input.name ?? "",
			});
			return row ? mask(row) : null;
		}),

	remove: withPermission("server", "delete")
		.input(apiRemoveCloudProvider)
		.mutation(async ({ input, ctx }) => {
			const existing = await db.query.cloudProvider.findFirst({
				where: and(
					eq(cloudProvider.cloudProviderId, input.cloudProviderId),
					eq(cloudProvider.organizationId, ctx.session.activeOrganizationId),
				),
			});
			if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
			// Refuse if an autoscaling group still references it (avoid orphaning a
			// group's credential out from under it).
			const inUse = await db.query.clusterAutoscaler.findFirst({
				where: eq(clusterAutoscaler.cloudProviderId, input.cloudProviderId),
				columns: { autoscalerId: true, name: true },
			});
			if (inUse)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `In use by autoscaling group "${inUse.name}". Reassign or delete that group first.`,
				});
			await db
				.delete(cloudProvider)
				.where(eq(cloudProvider.cloudProviderId, input.cloudProviderId));
			await audit(ctx, {
				action: "delete",
				resourceType: "cloudProvider",
				resourceId: input.cloudProviderId,
				resourceName: existing.name,
			});
			return true;
		}),

	testConnection: withPermission("server", "create")
		.input(apiTestCloudProvider)
		.mutation(async ({ input, ctx }) => {
			// Use the provided token, else the saved provider's token.
			let token = input.token;
			if (!token && input.cloudProviderId) {
				const row = await db.query.cloudProvider.findFirst({
					where: and(
						eq(cloudProvider.cloudProviderId, input.cloudProviderId),
						eq(cloudProvider.organizationId, ctx.session.activeOrganizationId),
					),
					columns: { token: true },
				});
				token = row?.token;
			}
			try {
				return await testProviderToken(input.provider, token || "");
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : "Test failed",
				});
			}
		}),
});
