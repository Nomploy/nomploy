import { db } from "@nomploy/server/db";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateDnsProvider,
	apiFindOneDnsProvider,
	apiRemoveDnsProvider,
	apiUpdateDnsProvider,
	dnsProvider,
} from "@/server/db/schema";

/** Validate a provider token against the vendor API. Throws on failure. */
const testProviderToken = async (
	provider: string,
	token: string,
): Promise<{ ok: true; detail: string }> => {
	if (!token) throw new Error("No token provided");
	if (provider === "cloudflare") {
		// Cloudflare token verify endpoint — confirms the token is valid + active.
		const res = await fetch(
			"https://api.cloudflare.com/client/v4/user/tokens/verify",
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (res.status === 401 || res.status === 403)
			throw new Error("Invalid or unauthorized Cloudflare token");
		const data = (await res.json()) as {
			success?: boolean;
			result?: { status?: string };
			errors?: { message?: string }[];
		};
		if (!res.ok || !data.success)
			throw new Error(
				data.errors?.[0]?.message || `Cloudflare API error ${res.status}`,
			);
		return {
			ok: true,
			detail: `Token valid (status: ${data.result?.status ?? "active"}).`,
		};
	}
	throw new Error(`Unsupported DNS provider: ${provider}`);
};

// Strip the token from a row before returning it; expose only whether one is set.
const mask = <T extends { token: string }>(row: T) => {
	const { token, ...rest } = row;
	return { ...rest, hasToken: !!token };
};

export const dnsProviderRouter = createTRPCRouter({
	all: withPermission("server", "read").query(async ({ ctx }) => {
		const rows = await db.query.dnsProvider.findMany({
			where: eq(dnsProvider.organizationId, ctx.session.activeOrganizationId),
			orderBy: desc(dnsProvider.createdAt),
		});
		return rows.map(mask);
	}),

	one: withPermission("server", "read")
		.input(apiFindOneDnsProvider)
		.query(async ({ input, ctx }) => {
			const row = await db.query.dnsProvider.findFirst({
				where: and(
					eq(dnsProvider.dnsProviderId, input.dnsProviderId),
					eq(dnsProvider.organizationId, ctx.session.activeOrganizationId),
				),
			});
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			return mask(row);
		}),

	create: withPermission("server", "create")
		.input(apiCreateDnsProvider)
		.mutation(async ({ input, ctx }) => {
			const [row] = await db
				.insert(dnsProvider)
				.values({
					name: input.name,
					provider: input.provider,
					token: input.token,
					enabled: input.enabled ?? false,
					organizationId: ctx.session.activeOrganizationId,
				})
				.returning();
			if (!row)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the DNS provider",
				});
			await audit(ctx, {
				action: "create",
				resourceType: "dnsProvider",
				resourceId: row.dnsProviderId,
				resourceName: input.name,
			});
			return mask(row);
		}),

	update: withPermission("server", "create")
		.input(apiUpdateDnsProvider)
		.mutation(async ({ input, ctx }) => {
			const existing = await db.query.dnsProvider.findFirst({
				where: and(
					eq(dnsProvider.dnsProviderId, input.dnsProviderId),
					eq(dnsProvider.organizationId, ctx.session.activeOrganizationId),
				),
			});
			if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
			const [row] = await db
				.update(dnsProvider)
				.set({
					...(input.name !== undefined ? { name: input.name } : {}),
					...(input.provider !== undefined ? { provider: input.provider } : {}),
					...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
					// Only overwrite the token when a non-empty one is provided.
					...(input.token ? { token: input.token } : {}),
				})
				.where(eq(dnsProvider.dnsProviderId, input.dnsProviderId))
				.returning();
			await audit(ctx, {
				action: "update",
				resourceType: "dnsProvider",
				resourceId: input.dnsProviderId,
				resourceName: row?.name ?? input.name ?? "",
			});
			return row ? mask(row) : null;
		}),

	remove: withPermission("server", "delete")
		.input(apiRemoveDnsProvider)
		.mutation(async ({ input, ctx }) => {
			const existing = await db.query.dnsProvider.findFirst({
				where: and(
					eq(dnsProvider.dnsProviderId, input.dnsProviderId),
					eq(dnsProvider.organizationId, ctx.session.activeOrganizationId),
				),
			});
			if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
			await db
				.delete(dnsProvider)
				.where(eq(dnsProvider.dnsProviderId, input.dnsProviderId));
			await audit(ctx, {
				action: "delete",
				resourceType: "dnsProvider",
				resourceId: input.dnsProviderId,
				resourceName: existing.name,
			});
			return true;
		}),

	testConnection: withPermission("server", "create")
		.input(
			z.object({
				provider: z.string().min(1),
				token: z.string().optional(),
				dnsProviderId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			let token = input.token;
			if (!token && input.dnsProviderId) {
				const row = await db.query.dnsProvider.findFirst({
					where: and(
						eq(dnsProvider.dnsProviderId, input.dnsProviderId),
						eq(dnsProvider.organizationId, ctx.session.activeOrganizationId),
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
