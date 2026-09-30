import { randomBytes } from "node:crypto";
import { db } from "@nomploy/server/db";
import {
	type apiCreateRegistry,
	destinations,
	registry,
} from "@nomploy/server/db/schema";
import {
	execAsync,
	execAsyncRemote,
} from "@nomploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import bcrypt from "bcrypt";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import { IS_CLOUD } from "../constants";
import { pointDomainAtLb } from "../setup/loadbalancer-dns";
import { nomadFetch } from "../setup/pack-nomad";
import { syncRegistryAuthToConsul } from "../setup/registry-auth";
import { generateZotRegistryJob } from "../utils/builders/nomad-registry";
import { encodeBase64 } from "../utils/docker/utils";
import { getDefaultCertResolver } from "./cert-resolver";

export type Registry = typeof registry.$inferSelect;

function shEscape(s: string | undefined): string {
	if (!s) return "''";
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function safeDockerLoginCommand(
	registry: string | undefined,
	user: string | undefined,
	pass: string | undefined,
) {
	const escapedRegistry = shEscape(registry);
	const escapedUser = shEscape(user);
	const escapedPassword = shEscape(pass);
	return `printf %s ${escapedPassword} | docker login ${escapedRegistry} -u ${escapedUser} --password-stdin`;
}

export const createRegistry = async (
	input: z.infer<typeof apiCreateRegistry>,
	organizationId: string,
) => {
	const created = await db.transaction(async (tx) => {
		const newRegistry = await tx
			.insert(registry)
			.values({
				...input,
				organizationId: organizationId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newRegistry) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input:  Inserting registry",
			});
		}

		if (IS_CLOUD && !input.serverId && input.serverId !== "none") {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Select a server to add the registry",
			});
		}
		const loginCommand = safeDockerLoginCommand(
			input.registryUrl,
			input.username,
			input.password,
		);
		if (input.serverId && input.serverId !== "none") {
			await execAsyncRemote(input.serverId, loginCommand);
		} else if (newRegistry.registryType === "cloud") {
			await execAsync(loginCommand);
		}

		return newRegistry;
	});
	// Publish the merged registry auth to Consul KV → consul-template renders it
	// to /root/.docker/config.json on every node (private multi-node pulls).
	await syncRegistryAuthToConsul().catch(() => {});
	return created;
};

export const removeRegistry = async (registryId: string) => {
	try {
		const response = await db
			.delete(registry)
			.where(eq(registry.registryId, registryId))
			.returning()
			.then((res) => res[0]);

		if (!response) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Registry not found",
			});
		}

		if (!IS_CLOUD) {
			await execAsync(`docker logout ${shEscape(response.registryUrl)}`);
		}

		// A self-hosted registry owns a zot Nomad job — purge it on delete.
		if (response.registryType === "selfHosted") {
			const job = registryJobName(response.registryId);
			await execAsync(
				`nomad job stop -purge ${shEscape(job)} 2>&1 || true`,
			).catch(() => {});
		}

		await syncRegistryAuthToConsul().catch(() => {});
		return response;
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error removing this registry",
			cause: error,
		});
	}
};

export const updateRegistry = async (
	registryId: string,
	registryData: Partial<Registry> & { serverId?: string | null },
) => {
	try {
		const response = await db
			.update(registry)
			.set({
				...registryData,
			})
			.where(eq(registry.registryId, registryId))
			.returning()
			.then((res) => res[0]);

		const loginCommand = safeDockerLoginCommand(
			response?.registryUrl,
			response?.username,
			response?.password,
		);

		if (
			IS_CLOUD &&
			!registryData?.serverId &&
			registryData?.serverId !== "none"
		) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Select a server to add the registry",
			});
		}

		if (registryData?.serverId && registryData?.serverId !== "none") {
			await execAsyncRemote(registryData.serverId, loginCommand);
		} else if (response?.registryType === "cloud") {
			await execAsync(loginCommand);
		}

		await syncRegistryAuthToConsul().catch(() => {});
		return response;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Error updating this registry";
		throw new TRPCError({
			code: "BAD_REQUEST",
			message,
		});
	}
};

export const findRegistryById = async (registryId: string) => {
	const registryResponse = await db.query.registry.findFirst({
		where: eq(registry.registryId, registryId),
		columns: {
			password: false,
		},
	});
	if (!registryResponse) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Registry not found",
		});
	}
	return registryResponse;
};

export const findAllRegistryByOrganizationId = async (
	organizationId: string,
) => {
	const registryResponse = await db.query.registry.findMany({
		where: eq(registry.organizationId, organizationId),
	});
	return registryResponse;
};

/**
 * Provision a self-hosted, S3-backed zot registry and register it. The panel reads
 * the chosen S3 destination's credentials SERVER-SIDE (they never leave the host),
 * renders a zot Nomad job (see generateZotRegistryJob), runs it, points `domain` at
 * the LoadBalancer (grey-cloud, so image layers don't traverse the Cloudflare
 * proxy), and stores a `selfHosted` registry row builds can push/pull through.
 *
 * TLS is terminated by the existing Traefik/DNS-01 ingress on `domain`, so cluster
 * nodes pull over a valid cert with no per-node `insecure-registries` daemon config.
 */
export const provisionSelfHostedRegistry = async (
	input: {
		registryName: string;
		domain: string;
		destinationId: string;
		imagePrefix?: string | null;
	},
	organizationId: string,
) => {
	const dest = await db.query.destinations.findFirst({
		where: and(
			eq(destinations.destinationId, input.destinationId),
			eq(destinations.organizationId, organizationId),
		),
	});
	if (!dest) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "S3 destination not found",
		});
	}

	const username = "nomploy";
	// A strong random password; stored (like every registry) so builds can log in.
	const password = randomBytes(24).toString("base64url");
	const htpasswd = `${username}:${bcrypt.hashSync(password, 10)}`;

	// Insert the row FIRST so the mutation returns immediately (the DNS + login
	// steps below are slow — the Cloudflare API call was timing out the request).
	// The zot job name is derived from the registryId so teardown can recompute it.
	const [row] = await db
		.insert(registry)
		.values({
			registryName: input.registryName,
			username,
			password,
			registryUrl: input.domain,
			registryType: "selfHosted",
			imagePrefix: input.imagePrefix ?? null,
			organizationId,
		})
		.returning();
	if (!row) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the registry",
		});
	}
	const appName = registryJobName(row.registryId);

	const certResolver = await getDefaultCertResolver().catch(
		() => "letsencrypt",
	);
	const job = generateZotRegistryJob({
		appName,
		domain: input.domain,
		htpasswd,
		s3: {
			endpoint: dest.endpoint,
			region: dest.region,
			bucket: dest.bucket,
			accessKey: dest.accessKey,
			secretKey: dest.secretAccessKey,
			// Key prefix inside the bucket — keeps registry blobs separate from any
			// other content (e.g. DB backups) in the same bucket.
			rootDirectory: "zot",
		},
		certResolver,
		deployedAt: new Date().toISOString(),
	});

	// Deploy the job (control plane). A service job with no update{} stanza returns
	// at registration, so this is quick. Roll it back if registration fails so a
	// dead row isn't left behind.
	const jobFile = `/etc/nomploy/registry/${appName}.nomad.hcl`;
	const encoded = encodeBase64(job);
	try {
		await execAsync(
			`set -e; mkdir -p /etc/nomploy/registry; echo "${encoded}" | base64 -d > "${jobFile}"; nomad job run "${jobFile}" 2>&1`,
		);
	} catch (error) {
		await db
			.delete(registry)
			.where(eq(registry.registryId, row.registryId))
			.catch(() => {});
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Failed to deploy the registry job: ${
				error instanceof Error ? error.message : String(error)
			}`,
		});
	}

	// The rest is slow (Cloudflare DNS + cert wait) — run it in the background so
	// the mutation returns now; the UI can poll the registry job's health.
	void (async () => {
		await pointDomainAtLb(organizationId, input.domain).catch((e) =>
			console.error("registry DNS point failed:", e),
		);
		await syncRegistryAuthToConsul().catch(() => {});
		// Best-effort `docker login` with retries — the DNS-01 cert can take a minute.
		const cmd = safeDockerLoginCommand(input.domain, username, password);
		for (let i = 0; i < 15; i++) {
			try {
				await execAsync(cmd);
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 15000));
			}
		}
		console.error(
			`registry: docker login to ${input.domain} not yet succeeded; retried on first push`,
		);
	})();

	return row;
};

/** Deterministic Nomad job id for a self-hosted registry (derivable for teardown). */
export const registryJobName = (registryId: string): string =>
	`nomploy-reg-${registryId
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 12)}`;

export type SelfHostedRegistryState =
	| "provisioning"
	| "healthy"
	| "failed"
	| "not_found"
	| "unknown";

/**
 * Health of a self-hosted registry's zot Nomad job, for the UI. Resolves the job
 * (derived from the registryId), reads its allocations, and reports a state plus a
 * short message drawn from the latest task event when it's failing — so a bad
 * config (crash loop) is visible in the panel instead of only via the Nomad API.
 */
export const getSelfHostedRegistryStatus = async (
	registryId: string,
	organizationId: string,
): Promise<{ state: SelfHostedRegistryState; message?: string }> => {
	const reg = await db.query.registry.findFirst({
		where: and(
			eq(registry.registryId, registryId),
			eq(registry.organizationId, organizationId),
		),
	});
	if (!reg || reg.registryType !== "selfHosted") return { state: "unknown" };

	const jobName = registryJobName(registryId);
	try {
		const allocs = await nomadFetch<
			{
				JobVersion?: number;
				ClientStatus?: string;
				TaskStates?: {
					zot?: { Events?: { DisplayMessage?: string }[] };
				};
			}[]
		>(`/job/${encodeURIComponent(jobName)}/allocations`);
		if (!allocs || allocs.length === 0) {
			const job = await nomadFetch(`/job/${encodeURIComponent(jobName)}`).catch(
				() => null,
			);
			return { state: job ? "provisioning" : "not_found" };
		}
		const latest = Math.max(...allocs.map((a) => a.JobVersion ?? 0));
		const cur = allocs.filter((a) => (a.JobVersion ?? 0) === latest);
		if (cur.some((a) => a.ClientStatus === "running"))
			return { state: "healthy" };
		if (
			cur.length > 0 &&
			cur.every((a) => a.ClientStatus === "failed" || a.ClientStatus === "lost")
		) {
			const events = cur[0]?.TaskStates?.zot?.Events ?? [];
			const msg = [...events]
				.reverse()
				.find(
					(e: { DisplayMessage?: string }) =>
						e.DisplayMessage && /error|exit|fail/i.test(e.DisplayMessage),
				)?.DisplayMessage;
			return { state: "failed", message: msg };
		}
		return { state: "provisioning" };
	} catch {
		return { state: "unknown" };
	}
};
