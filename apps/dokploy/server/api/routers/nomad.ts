import { findServerById, updateServerById } from "@nomploy/server";
import { db } from "@nomploy/server/db";
import {
	apiSetDesiredCount,
	apiUpsertAutoscalingGroup,
	apiUpsertAutoscalingSchedule,
	apiUpsertLoadBalancer,
	autoscalingSchedule,
	cloudProvider,
	clusterAutoscaler,
	clusterAutoscalerEvents,
	dnsProvider,
	environments,
	loadBalancer,
	networkPolicies,
	projects,
	server as serverTable,
} from "@nomploy/server/db/schema";
import {
	findApplicationById,
	updateApplication,
} from "@nomploy/server/services/application";
import {
	findComposeById,
	updateCompose,
} from "@nomploy/server/services/compose";
import { checkServicePermissionAndAccess } from "@nomploy/server/services/permission";
import { getScalingSuggestions } from "@nomploy/server/services/scaling-suggestions";
import { getProvisioner } from "@nomploy/server/setup/autoscale";
import {
	evaluateCluster,
	provisionAndJoinNode,
	reconcileAutoscaler,
} from "@nomploy/server/setup/autoscale/reconcile";
import {
	removeAutoscalingScheduleJob,
	rescheduleAutoscalingAction,
} from "@nomploy/server/setup/autoscale/schedule";
import {
	cfListZones,
	clearLoadBalancerDns,
	generateLbHostname,
	getLoadBalancerMetrics,
	getLoadBalancerMetricsHistory,
	reconcileLoadBalancerDns,
	resolveLbNodes,
} from "@nomploy/server/setup/loadbalancer-dns";
import { getNomadBootstrapCommand } from "@nomploy/server/setup/nomad-bootstrap";
import {
	getClusterServerJoinCommand,
	getClusterWorkerJoinCommand,
} from "@nomploy/server/setup/nomad-cluster";
import {
	meshServicesFromCatalog,
	syncIntentionsForOrg,
} from "@nomploy/server/setup/nomad-connect";
import {
	addPeerEverywhere,
	allMeshMembers,
	allocateWgIp,
	allServers,
	readCluster,
	readClusterAclTokens,
	removePeerEverywhere,
	serverMeshMembers,
	writeCluster,
} from "@nomploy/server/setup/nomad-mesh";
import {
	deployTraefikHaSystemJob,
	getPoolCertMeta,
	stopTraefikHaSystemJob,
	syncTraefikCertsToConsulKV,
	TRAEFIK_HA_JOB_NAME,
} from "@nomploy/server/setup/traefik-ha";
import {
	execAsync,
	execAsyncRemote,
} from "@nomploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

// Control-plane-local Nomad (used when no serverId is given).
const DEFAULT_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const DEFAULT_TOKEN = process.env.NOMAD_TOKEN || "";

interface NomadConfig {
	address: string;
	token: string;
	namespace: string;
}

/**
 * Resolve which Nomad cluster a request targets.
 * - With a serverId: use that server's stored connection (nomadAddress / nomadToken
 *   / nomadNamespace), after verifying the server belongs to the caller's org.
 * - Without: fall back to the control plane's own local Nomad.
 *
 * NOTE: transport is plain HTTP here. The seam for a future SSH-tunnel is
 * `nomadClient()` below — swap how the request is made without touching callers.
 */
const resolveNomad = async (
	ctx: { session?: { activeOrganizationId?: string } | null },
	serverId?: string,
): Promise<NomadConfig> => {
	if (!serverId) {
		return {
			address: DEFAULT_ADDRESS,
			token: DEFAULT_TOKEN,
			namespace: "default",
		};
	}

	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.session?.activeOrganizationId) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	if (!server.nomadAddress) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"This server has no Nomad address configured. Set it in the server's Nomad settings.",
		});
	}

	return {
		address: server.nomadAddress,
		token: server.nomadToken ?? "",
		namespace: server.nomadNamespace ?? "default",
	};
};

const nomadClient = (cfg: NomadConfig) => {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (cfg.token) headers["X-Nomad-Token"] = cfg.token;

	const url = (path: string) => {
		const base = `${cfg.address.replace(/\/$/, "")}/v1${path}`;
		return base;
	};

	return {
		namespace: cfg.namespace,
		async request(path: string, init?: RequestInit) {
			return fetch(url(path), {
				...init,
				headers: { ...headers, ...init?.headers },
			});
		},
		async get(path: string) {
			const res = await this.request(path);
			if (!res.ok) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Nomad API error: ${res.status} ${res.statusText}`,
				});
			}
			return res.json();
		},
	};
};

// Append a namespace query param to a path (for namespaced endpoints).
const withNs = (path: string, namespace: string) => {
	if (!namespace || namespace === "*") return path;
	const sep = path.includes("?") ? "&" : "?";
	return `${path}${sep}namespace=${encodeURIComponent(namespace)}`;
};

// Keys with this prefix in a job's Nomad Variable (nomad/jobs/<appName>) hold
// config-FILE content (rendered to a mounted file), not env secrets. The two
// share one variable because Nomad's workload identity only reliably grants a
// task read access to that single job-level path. Both the env-secrets template
// (which skips these keys) and the config-file handlers key off this prefix.
const CONFIG_FILE_PREFIX = "nmplcfg_";

type NomadHttpClient = ReturnType<typeof nomadClient>;

// Read a Nomad Variable's Items map (empty when the variable doesn't exist yet).
const readVariableItems = async (
	client: NomadHttpClient,
	varPath: string,
	namespace: string,
): Promise<Record<string, string>> => {
	const res = await client.request(withNs(varPath, namespace));
	if (res.status === 404) return {};
	if (!res.ok) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Nomad variable read failed: ${res.status} ${res.statusText}`,
		});
	}
	const v = (await res.json()) as { Items?: Record<string, string> };
	return v.Items ?? {};
};

// Write the full Items set, or DELETE the variable when nothing is left (so an
// emptied variable doesn't linger). `varPath` is the /var/... request path;
// `logicalPath` is the nomad/jobs/... path stored in the PUT body.
const writeOrDeleteVariable = async (
	client: NomadHttpClient,
	varPath: string,
	logicalPath: string,
	items: Record<string, string>,
	namespace: string,
): Promise<void> => {
	if (Object.keys(items).length === 0) {
		const del = await client.request(withNs(varPath, namespace), {
			method: "DELETE",
		});
		if (!del.ok && del.status !== 404) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: `Nomad variable delete failed: ${del.status} ${del.statusText}`,
			});
		}
		return;
	}
	const put = await client.request(withNs(varPath, namespace), {
		method: "PUT",
		body: JSON.stringify({ Path: logicalPath, Items: items }),
	});
	if (!put.ok) {
		const detail = await put.text().catch(() => "");
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Nomad variable write failed: ${put.status} ${detail}`,
		});
	}
};

/**
 * Resolve a Nomad Pack deployment to its real Nomad job ids. `nomad-pack run
 * --name <appName>` sets each deployed job's `pack.deployment_name` meta to
 * appName, but the job IDs come from the pack template (and a pack can register
 * several). So logs/allocations/scale — which address a job by appName — find
 * nothing for a pack. This maps appName → the actual job ids via that meta.
 */
const resolvePackJobIds = async (
	cfg: NomadConfig,
	deploymentName: string,
): Promise<string[]> => {
	try {
		const res = await nomadClient(cfg).request(
			withNs("/jobs?meta=true", cfg.namespace),
		);
		if (!res.ok) return [];
		const jobs = (await res.json()) as Array<{
			ID: string;
			Meta?: Record<string, string> | null;
		}>;
		return jobs
			.filter((j) => (j.Meta || {})["pack.deployment_name"] === deploymentName)
			.map((j) => j.ID);
	} catch {
		return [];
	}
};

// Reverse of resolvePackJobIds: jobId → the pack deployment_name (== the compose
// appName) for every Nomad Pack job. A pack names its Nomad job after the pack,
// not the appName, so telemetry (labelled by that job id) must be attributed back
// to the service through this map. [[nomploy-nomad-packs]]
const resolvePackJobMap = async (
	cfg: NomadConfig,
): Promise<Map<string, string>> => {
	const map = new Map<string, string>();
	try {
		const res = await nomadClient(cfg).request(
			withNs("/jobs?meta=true", cfg.namespace),
		);
		if (!res.ok) return map;
		const jobs = (await res.json()) as Array<{
			ID: string;
			Meta?: Record<string, string> | null;
		}>;
		for (const j of jobs) {
			const dn = (j.Meta || {})["pack.deployment_name"];
			if (dn) map.set(j.ID, dn);
		}
	} catch {}
	return map;
};

// ── Consul (service catalog + health) ──────────────────────────────────────
// Read-only. The control-plane Consul holds the whole cluster's catalog, so with
// no serverId we read it directly; for a remote standalone cluster we reuse that
// server's Nomad host on Consul's port. Never exposed to the network — the native
// Consul UI stays bound to 127.0.0.1; this surfaces its data behind the panel.
const DEFAULT_CONSUL_ADDRESS =
	process.env.CONSUL_ADDRESS || "http://127.0.0.1:8500";
const DEFAULT_CONSUL_TOKEN = process.env.CONSUL_TOKEN || "";

const resolveConsul = async (
	ctx: { session?: { activeOrganizationId?: string } | null },
	serverId?: string,
): Promise<{ address: string; token: string }> => {
	if (!serverId)
		return { address: DEFAULT_CONSUL_ADDRESS, token: DEFAULT_CONSUL_TOKEN };

	const server = await findServerById(serverId);
	if (server.organizationId !== ctx.session?.activeOrganizationId) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	// Derive Consul from the server's Nomad address (same host, Consul's port).
	const base = server.nomadAddress || DEFAULT_CONSUL_ADDRESS;
	const address = base.replace(/:\d+(?=\/?$)/, ":8500");
	return { address, token: "" };
};

const consulGet = async (
	cfg: { address: string; token: string },
	path: string,
) => {
	const headers: Record<string, string> = {};
	if (cfg.token) headers["X-Consul-Token"] = cfg.token;
	const res = await fetch(`${cfg.address.replace(/\/$/, "")}/v1${path}`, {
		headers,
	});
	if (!res.ok) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Consul API error: ${res.status} ${res.statusText}`,
		});
	}
	return res.json();
};

const DEFAULT_CONSUL = {
	address: DEFAULT_CONSUL_ADDRESS,
	token: DEFAULT_CONSUL_TOKEN,
};

const serverInput = z.object({ serverId: z.string().optional() });

// Terminal marker streamed on any non-success completion (graceful abort or
// error). The client resets its busy state when it sees this; success paths use
// their own JOIN_DONE / REMOVE_DONE / BOOTSTRAP_DONE sentinels. Without a
// terminal signal the subscription just completes and the spinner never clears.
const OP_ENDED = "OP_ENDED";

// Shared error emitter for cluster join/remove: reachability failures (cloud
// firewall, wrong IP) are by far the most common cause — make the fix actionable.
type ClusterEmit = { next: (s: string) => void; complete: () => void };
const emitClusterError = (
	emit: ClusterEmit,
	err: unknown,
	server: { ipAddress: string; port: number },
) => {
	const message =
		err instanceof Error ? err.message : "Cluster operation failed";
	emit.next(`\n❌ ${message}\n`);
	if (
		/handshake|timed?\s*out|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|connect/i.test(
			message,
		)
	) {
		const hubHost = readCluster()?.hubEndpoint?.replace(/:\d+$/, "");
		emit.next(
			`\nThe control plane could not open an SSH connection to ${server.ipAddress}:${server.port}.\n` +
				"This is almost always network reachability, not a bad key:\n" +
				"  • If this node is behind a cloud firewall (Hetzner, AWS SG, …), allow inbound\n" +
				`    TCP/${server.port} (SSH) and UDP/51820 (WireGuard) from the control-plane IP${
					hubHost ? ` (${hubHost})` : ""
				}.\n` +
				"  • If both machines share a private network, set this server's IP to its\n" +
				"    private address — the control plane reaches it there with no public exposure.\n",
		);
	}
	emit.next(OP_ENDED);
	emit.complete();
};

// Pre-flight before the heavy install: confirm the control plane can SSH in with
// root/sudo. The most common join failure by far is the node not trusting the
// panel's SSH key yet ("reachable, not added"). Catching it here — before an IP
// is allocated or anything is installed — and printing the exact public key plus
// a one-line authorize command turns a cryptic late failure into a copy-paste
// fix. Returns true to proceed; on failure it emits guidance, ends the stream,
// and returns false.
type PreflightServer = {
	serverId: string;
	name: string;
	ipAddress: string;
	port: number;
	sshKey?: { publicKey?: string | null } | null;
};
const preflightNode = async (
	emit: ClusterEmit,
	server: PreflightServer,
): Promise<boolean> => {
	emit.next(`Checking SSH access to "${server.name}" …\n`);
	try {
		let sudoMissing = false;
		await execAsyncRemote(
			server.serverId,
			'if [ "$(id -u)" = "0" ] || sudo -n true 2>/dev/null; then echo NOMPLOY_SUDO_OK; else echo NOMPLOY_SUDO_MISSING; fi',
			(log) => {
				if (log.includes("NOMPLOY_SUDO_MISSING")) sudoMissing = true;
			},
		);
		if (sudoMissing) {
			emit.next(
				'\n❌ Connected, but the login user lacks passwordless sudo.\nUse "root", or grant this user NOPASSWD sudo, then retry.\n',
			);
			emit.next(OP_ENDED);
			emit.complete();
			return false;
		}
		emit.next("SSH + sudo OK ✅\n");
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// SSH auth failure → the node doesn't trust the panel key. Hand back the
		// public key + the command to authorize it.
		if (/auth|denied|publickey|not accepted|invalid.*key/i.test(message)) {
			const pub = server.sshKey?.publicKey?.trim();
			emit.next(
				`\n❌ Could not authenticate to "${server.name}" over SSH (${message}).\n`,
			);
			if (pub) {
				emit.next(
					"\nThe node doesn't trust this panel's SSH key yet. Run this ON the node\n" +
						"(as the login user), then click Join again:\n\n" +
						`  mkdir -p ~/.ssh && chmod 700 ~/.ssh && \\\n    echo '${pub}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys\n`,
				);
			} else {
				emit.next(
					"\nThis server has no SSH key set — add one in the server's settings first.\n",
				);
			}
			emit.next(OP_ENDED);
			emit.complete();
			return false;
		}
		// Anything else (timeout, refused, unreachable) → firewall/reachability hint.
		emitClusterError(emit, err, server);
		return false;
	}
};

export const nomadRouter = createTRPCRouter({
	getJobs: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			return nomadClient(cfg).get(withNs("/jobs", cfg.namespace));
		}),

	getJob: withPermission("server", "read")
		.input(serverInput.extend({ jobId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			const direct = await client.request(
				withNs(`/job/${input.jobId}`, cfg.namespace),
			);
			if (direct.ok) return direct.json();
			// Nomad Pack: appName isn't the job id — resolve the pack's real jobs.
			const [first] = await resolvePackJobIds(cfg, input.jobId);
			if (first) return client.get(withNs(`/job/${first}`, cfg.namespace));
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Job ${input.jobId} not found`,
			});
		}),

	getJobAllocations: withPermission("server", "read")
		.input(serverInput.extend({ jobId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			const direct = await client.request(
				withNs(`/job/${input.jobId}/allocations`, cfg.namespace),
			);
			if (direct.ok) {
				const allocs = (await direct.json()) as unknown[];
				if (Array.isArray(allocs) && allocs.length > 0) return allocs;
			}
			// Empty or job-not-found: a Nomad Pack registers jobs under other ids —
			// union the allocations across the pack's real jobs.
			const packIds = await resolvePackJobIds(cfg, input.jobId);
			if (packIds.length === 0) return [];
			const per = await Promise.all(
				packIds.map(async (id) => {
					const r = await client.request(
						withNs(`/job/${id}/allocations`, cfg.namespace),
					);
					return r.ok ? ((await r.json()) as unknown[]) : [];
				}),
			);
			return per.flat();
		}),

	// Live per-service resource usage from Nomad telemetry (publish_allocation_metrics).
	// Metrics are per-agent (no central TSDB), so scrape every ready node's
	// /v1/metrics and sum the job's per-task cpu%/memory by task group. Current
	// snapshot only — the client polls and builds a rolling graph.
	getServiceMetrics: withPermission("server", "read")
		.input(serverInput.extend({ jobId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			// biome-ignore lint/suspicious/noExplicitAny: Nomad node list shape
			const nodes = (await client.get(
				withNs("/nodes", cfg.namespace),
			)) as any[];
			const ready = (nodes ?? []).filter((n) => n.Status === "ready");
			// Resolve each ready node's HTTP address (bound on wg0), deduped.
			const addrs = new Set<string>();
			await Promise.all(
				ready.map(async (n) => {
					try {
						const r = await client.request(
							withNs(`/node/${n.ID}`, cfg.namespace),
						);
						if (!r.ok) return;
						const node = (await r.json()) as { HTTPAddr?: string };
						if (node.HTTPAddr) addrs.add(node.HTTPAddr);
					} catch {}
				}),
			);
			// The control plane's own address is always reachable — include it.
			addrs.add(cfg.address.replace(/^https?:\/\//, "").replace(/\/$/, ""));

			// A Nomad Pack registers jobs under ids != appName, so accept both the
			// appName and the pack's real job ids when filtering the metrics.
			const jobIds = new Set([
				input.jobId,
				...(await resolvePackJobIds(cfg, input.jobId)),
			]);

			const cpuLine =
				/nomad_client_allocs_cpu_total_percent\{([^}]*)\}\s+([0-9.e+-]+)/g;
			const memLine =
				/nomad_client_allocs_memory_usage\{([^}]*)\}\s+([0-9.e+-]+)/g;
			const label = (labels: string, key: string) =>
				labels.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? "";
			// group → { cpu%, memBytes }
			const acc: Record<string, { cpu: number; mem: number }> = {};
			const scrape = async (addr: string) => {
				try {
					const ctl = new AbortController();
					const t = setTimeout(() => ctl.abort(), 4000);
					const res = await fetch(
						`http://${addr}/v1/metrics?format=prometheus`,
						{
							headers: cfg.token ? { "X-Nomad-Token": cfg.token } : {},
							signal: ctl.signal,
						},
					);
					clearTimeout(t);
					if (!res.ok) return;
					const text = await res.text();
					for (const m of text.matchAll(cpuLine)) {
						if (!jobIds.has(label(m[1] ?? "", "job"))) continue;
						const g = label(m[1] ?? "", "task_group") || input.jobId;
						(acc[g] ??= { cpu: 0, mem: 0 }).cpu += Number(m[2]) || 0;
					}
					for (const m of text.matchAll(memLine)) {
						if (!jobIds.has(label(m[1] ?? "", "job"))) continue;
						const g = label(m[1] ?? "", "task_group") || input.jobId;
						(acc[g] ??= { cpu: 0, mem: 0 }).mem += Number(m[2]) || 0;
					}
				} catch {}
			};
			await Promise.all([...addrs].map(scrape));
			return {
				ts: Date.now(),
				groups: Object.entries(acc).map(([group, v]) => ({
					group,
					cpuPercent: Math.round(v.cpu * 10) / 10,
					memoryMb: Math.round(v.mem / (1024 * 1024)),
				})),
			};
		}),

	// Live CPU%/memory per PROJECT for the projects page. One telemetry scrape of
	// every ready node (publish_allocation_metrics), then each service's Nomad job
	// (= its appName) is summed into its project. Per-alloc STATS are all-zero on
	// this cgroup-v2 host but telemetry is real [[nomploy-per-alloc-stats-gap]].
	// Current snapshot only — the client polls. Returns {} silently if Nomad isn't
	// reachable so the projects page never errors.
	getProjectsMetrics: protectedProcedure.query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		const empty = { ts: Date.now(), projects: [] as never[] };
		let cfg: Awaited<ReturnType<typeof resolveNomad>>;
		try {
			cfg = await resolveNomad(ctx, undefined);
		} catch {
			return empty;
		}
		const client = nomadClient(cfg);
		// Metrics are per-agent (no central TSDB): scrape every ready node once and
		// sum a job's per-alloc CPU%/mem across nodes.
		// biome-ignore lint/suspicious/noExplicitAny: Nomad node list shape
		let nodes: any[] = [];
		try {
			nodes = (await client.get(withNs("/nodes", cfg.namespace))) as any[];
		} catch {
			return empty;
		}
		const ready = (nodes ?? []).filter((n) => n.Status === "ready");
		const addrs = new Set<string>();
		await Promise.all(
			ready.map(async (n) => {
				try {
					const r = await client.request(
						withNs(`/node/${n.ID}`, cfg.namespace),
					);
					if (!r.ok) return;
					const node = (await r.json()) as { HTTPAddr?: string };
					if (node.HTTPAddr) addrs.add(node.HTTPAddr);
				} catch {}
			}),
		);
		addrs.add(cfg.address.replace(/^https?:\/\//, "").replace(/\/$/, ""));

		const cpuLine =
			/nomad_client_allocs_cpu_total_percent\{([^}]*)\}\s+([0-9.e+-]+)/g;
		const memLine =
			/nomad_client_allocs_memory_usage\{([^}]*)\}\s+([0-9.e+-]+)/g;
		const label = (labels: string, key: string) =>
			labels.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? "";
		// Nomad Pack jobs are labelled by the pack's job id, not the appName; map
		// them back so a pack service's usage lands under its appName.
		const packMap = await resolvePackJobMap(cfg);
		// job (= appName) → { cpu%, memBytes }
		const byJob: Record<string, { cpu: number; mem: number }> = {};
		const scrape = async (addr: string) => {
			try {
				const ctl = new AbortController();
				const t = setTimeout(() => ctl.abort(), 4000);
				const res = await fetch(`http://${addr}/v1/metrics?format=prometheus`, {
					headers: cfg.token ? { "X-Nomad-Token": cfg.token } : {},
					signal: ctl.signal,
				});
				clearTimeout(t);
				if (!res.ok) return;
				const text = await res.text();
				for (const m of text.matchAll(cpuLine)) {
					const jobLabel = label(m[1] ?? "", "job");
					if (!jobLabel) continue;
					const job = packMap.get(jobLabel) ?? jobLabel;
					const cur = byJob[job] ?? { cpu: 0, mem: 0 };
					cur.cpu += Number(m[2]) || 0;
					byJob[job] = cur;
				}
				for (const m of text.matchAll(memLine)) {
					const jobLabel = label(m[1] ?? "", "job");
					if (!jobLabel) continue;
					const job = packMap.get(jobLabel) ?? jobLabel;
					const cur = byJob[job] ?? { cpu: 0, mem: 0 };
					cur.mem += Number(m[2]) || 0;
					byJob[job] = cur;
				}
			} catch {}
		};
		await Promise.all([...addrs].map(scrape));

		// Map each service's Nomad job (appName) → its project, then sum. Only appName
		// is selected per service to keep the json_build_array arg count tiny
		// [[nomploy-json-build-array-100-arg-limit]].
		const nameCol = { columns: { appName: true } } as const;
		const rows = await db.query.projects.findMany({
			where: eq(projects.organizationId, orgId),
			columns: { projectId: true },
			with: {
				environments: {
					columns: { environmentId: true },
					with: {
						applications: nameCol,
						compose: nameCol,
						postgres: nameCol,
						mysql: nameCol,
						mariadb: nameCol,
						mongo: nameCol,
						redis: nameCol,
						libsql: nameCol,
					},
				},
			},
		});
		const out: Record<string, { cpu: number; mem: number }> = {};
		for (const p of rows) {
			const agg = out[p.projectId] ?? { cpu: 0, mem: 0 };
			out[p.projectId] = agg;
			for (const env of p.environments) {
				const svc = [
					...env.applications,
					...env.compose,
					...env.postgres,
					...env.mysql,
					...env.mariadb,
					...env.mongo,
					...env.redis,
					...env.libsql,
				];
				for (const s of svc) {
					const m = byJob[s.appName];
					if (m) {
						agg.cpu += m.cpu;
						agg.mem += m.mem;
					}
				}
			}
		}
		return {
			ts: Date.now(),
			projects: Object.entries(out).map(([projectId, v]) => ({
				projectId,
				cpuPercent: Math.round(v.cpu * 10) / 10,
				memoryMb: Math.round(v.mem / (1024 * 1024)),
			})),
		};
	}),

	// Live USED-vs-RESERVED CPU/memory for one environment: per service + the
	// environment total. From Nomad telemetry (all-zero stats API notwithstanding):
	// used = cpu_total_ticks (MHz) / memory_usage (bytes); reserved = cpu_allocated
	// (MHz) / memory_allocated (bytes). Keyed by {type,id} so the env page's cards
	// match without needing appName client-side. Snapshot only — the client polls.
	getEnvironmentMetrics: withPermission("server", "read")
		.input(z.object({ environmentId: z.string() }))
		.query(async ({ input, ctx }) => {
			type M = {
				cpuUsedMhz: number;
				cpuAllocMhz: number;
				memUsedMb: number;
				memAllocMb: number;
			};
			const zero = (): M => ({
				cpuUsedMhz: 0,
				cpuAllocMhz: 0,
				memUsedMb: 0,
				memAllocMb: 0,
			});
			const empty = {
				ts: Date.now(),
				totals: zero(),
				services: [] as { type: string; id: string; metrics: M }[],
			};
			let cfg: Awaited<ReturnType<typeof resolveNomad>>;
			try {
				cfg = await resolveNomad(ctx, undefined);
			} catch {
				return empty;
			}
			const client = nomadClient(cfg);
			// biome-ignore lint/suspicious/noExplicitAny: Nomad node list shape
			let nodes: any[] = [];
			try {
				nodes = (await client.get(withNs("/nodes", cfg.namespace))) as any[];
			} catch {
				return empty;
			}
			const ready = (nodes ?? []).filter((n) => n.Status === "ready");
			const addrs = new Set<string>();
			await Promise.all(
				ready.map(async (n) => {
					try {
						const r = await client.request(
							withNs(`/node/${n.ID}`, cfg.namespace),
						);
						if (!r.ok) return;
						const node = (await r.json()) as { HTTPAddr?: string };
						if (node.HTTPAddr) addrs.add(node.HTTPAddr);
					} catch {}
				}),
			);
			addrs.add(cfg.address.replace(/^https?:\/\//, "").replace(/\/$/, ""));

			const label = (labels: string, key: string) =>
				labels.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? "";
			// Nomad Pack jobs are labelled by the pack's job id, not the appName; map
			// them back so a pack service's usage lands under its appName.
			const packMap = await resolvePackJobMap(cfg);
			// job (= appName) → raw sums (cpu MHz, mem bytes) across every alloc/task.
			const raw: Record<
				string,
				{ cpuUsed: number; cpuAlloc: number; memUsed: number; memAlloc: number }
			> = {};
			const fields: [
				RegExp,
				"cpuUsed" | "cpuAlloc" | "memUsed" | "memAlloc",
			][] = [
				[
					/nomad_client_allocs_cpu_total_ticks\{([^}]*)\}\s+([0-9.eE+-]+)/g,
					"cpuUsed",
				],
				[
					/nomad_client_allocs_cpu_allocated\{([^}]*)\}\s+([0-9.eE+-]+)/g,
					"cpuAlloc",
				],
				[
					/nomad_client_allocs_memory_usage\{([^}]*)\}\s+([0-9.eE+-]+)/g,
					"memUsed",
				],
				[
					/nomad_client_allocs_memory_allocated\{([^}]*)\}\s+([0-9.eE+-]+)/g,
					"memAlloc",
				],
			];
			const scrape = async (addr: string) => {
				try {
					const ctl = new AbortController();
					const t = setTimeout(() => ctl.abort(), 4000);
					const res = await fetch(
						`http://${addr}/v1/metrics?format=prometheus`,
						{
							headers: cfg.token ? { "X-Nomad-Token": cfg.token } : {},
							signal: ctl.signal,
						},
					);
					clearTimeout(t);
					if (!res.ok) return;
					const text = await res.text();
					for (const [re, field] of fields) {
						for (const m of text.matchAll(re)) {
							const jobLabel = label(m[1] ?? "", "job");
							if (!jobLabel) continue;
							const job = packMap.get(jobLabel) ?? jobLabel;
							const cur = raw[job] ?? {
								cpuUsed: 0,
								cpuAlloc: 0,
								memUsed: 0,
								memAlloc: 0,
							};
							cur[field] += Number(m[2]) || 0;
							raw[job] = cur;
						}
					}
				} catch {}
			};
			await Promise.all([...addrs].map(scrape));

			// Map each service's Nomad job (appName) → the {type,id} the card uses.
			// Only id + appName per service to keep the json_build_array arg count
			// tiny [[nomploy-json-build-array-100-arg-limit]].
			const env = await db.query.environments.findFirst({
				where: eq(environments.environmentId, input.environmentId),
				columns: { environmentId: true },
				with: {
					applications: { columns: { applicationId: true, appName: true } },
					compose: { columns: { composeId: true, appName: true } },
					postgres: { columns: { postgresId: true, appName: true } },
					mysql: { columns: { mysqlId: true, appName: true } },
					mariadb: { columns: { mariadbId: true, appName: true } },
					mongo: { columns: { mongoId: true, appName: true } },
					redis: { columns: { redisId: true, appName: true } },
					libsql: { columns: { libsqlId: true, appName: true } },
				},
			});

			const toMb = (b: number) => Math.round(b / (1024 * 1024));
			const metricsFor = (appName: string): M => {
				const r = raw[appName];
				if (!r) return zero();
				return {
					cpuUsedMhz: Math.round(r.cpuUsed),
					cpuAllocMhz: Math.round(r.cpuAlloc),
					memUsedMb: toMb(r.memUsed),
					memAllocMb: toMb(r.memAlloc),
				};
			};
			const services: { type: string; id: string; metrics: M }[] = [];
			const totals = zero();
			const add = (type: string, id: string, appName: string) => {
				const m = metricsFor(appName);
				services.push({ type, id, metrics: m });
				totals.cpuUsedMhz += m.cpuUsedMhz;
				totals.cpuAllocMhz += m.cpuAllocMhz;
				totals.memUsedMb += m.memUsedMb;
				totals.memAllocMb += m.memAllocMb;
			};
			for (const a of env?.applications ?? [])
				add("application", a.applicationId, a.appName);
			for (const c of env?.compose ?? [])
				add("compose", c.composeId, c.appName);
			for (const p of env?.postgres ?? [])
				add("postgres", p.postgresId, p.appName);
			for (const m of env?.mysql ?? []) add("mysql", m.mysqlId, m.appName);
			for (const m of env?.mariadb ?? [])
				add("mariadb", m.mariadbId, m.appName);
			for (const m of env?.mongo ?? []) add("mongo", m.mongoId, m.appName);
			for (const r of env?.redis ?? []) add("redis", r.redisId, r.appName);
			for (const l of env?.libsql ?? []) add("libsql", l.libsqlId, l.appName);

			return { ts: Date.now(), totals, services };
		}),

	// Utilization/scaling suggestions from the sampled metric history (over-
	// provisioned / running hot / idle). Powers the in-panel Suggestions list; the
	// same analysis drives the daily digest notification.
	getScalingSuggestions: protectedProcedure.query(async ({ ctx }) => {
		return getScalingSuggestions(ctx.session.activeOrganizationId);
	}),

	// HA "LoadBalancer": a Traefik system job on every node tagged nomploy_lb=true
	// (the hub is excluded — it runs the standalone Traefik). Members serve routes
	// from the local Consul catalog + shared certs from Consul KV.
	deployLoadBalancer: withPermission("server", "create").mutation(async () => {
		const { certCount } = await deployTraefikHaSystemJob();
		return { certCount };
	}),

	stopLoadBalancer: withPermission("server", "delete").mutation(
		async ({ ctx }) => {
			await stopTraefikHaSystemJob();
			// Don't leave DNS pointing at a torn-down pool — clear the A records now
			// instead of waiting for the 30s health-prune loop.
			const org = ctx.session.activeOrganizationId;
			const cfg = await db.query.loadBalancer.findFirst({
				where: eq(loadBalancer.organizationId, org),
			});
			if (cfg?.enabled) await clearLoadBalancerDns(org).catch(() => {});
			return true;
		},
	),

	// Re-seed the shared cert store (Consul KV) from the hub's acme.json — run
	// after cert renewals so the pool picks up fresh certs (file provider reloads).
	syncLoadBalancerCerts: withPermission("server", "create").mutation(
		async () => {
			const { certCount } = await syncTraefikCertsToConsulKV();
			return { certCount };
		},
	),

	// The certs the pool serves + their expiry (from the hub's acme.json).
	getLoadBalancerCerts: withPermission("server", "read").query(async () =>
		getPoolCertMeta(),
	),

	// --- Phase 2b: DNS-managed entry to the pool ---------------------------
	// The LB gets a generated hostname whose A records are kept equal to the
	// healthy pool nodes' public IPs (health-prune). Users CNAME app domains to it.
	getLoadBalancerConfig: withPermission("server", "read").query(
		async ({ ctx }) => {
			const org = ctx.session.activeOrganizationId;
			const cfg = await db.query.loadBalancer.findFirst({
				where: eq(loadBalancer.organizationId, org),
			});
			const providers = await db.query.dnsProvider.findMany({
				where: eq(dnsProvider.organizationId, org),
			});
			return {
				config: cfg
					? {
							hostname: cfg.hostname,
							zoneName: cfg.zoneName,
							dnsProviderId: cfg.dnsProviderId,
							enabled: cfg.enabled,
							ttl: cfg.ttl,
							lastReconcileAt: cfg.lastReconcileAt,
							lastReconcileStatus: cfg.lastReconcileStatus,
						}
					: null,
				dnsProviders: providers.map((p) => ({
					dnsProviderId: p.dnsProviderId,
					name: p.name,
					provider: p.provider,
				})),
			};
		},
	),

	// List the zones a DNS provider's token can manage (for zone selection).
	listLoadBalancerZones: withPermission("server", "read")
		.input(z.object({ dnsProviderId: z.string() }))
		.query(async ({ ctx, input }) => {
			const provider = await db.query.dnsProvider.findFirst({
				where: and(
					eq(dnsProvider.dnsProviderId, input.dnsProviderId),
					eq(dnsProvider.organizationId, ctx.session.activeOrganizationId),
				),
			});
			if (!provider?.token)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "DNS provider has no token",
				});
			const zones = await cfListZones(provider.token);
			return zones.map((z) => ({ id: z.id, name: z.name }));
		}),

	// Create/update the LB DNS config. Auto-generates the hostname on first setup
	// (lb-<random>.<zone>); zone defaults to the provider's first zone.
	upsertLoadBalancerConfig: withPermission("server", "create")
		.input(apiUpsertLoadBalancer)
		.mutation(async ({ ctx, input }) => {
			const org = ctx.session.activeOrganizationId;
			const provider = await db.query.dnsProvider.findFirst({
				where: and(
					eq(dnsProvider.dnsProviderId, input.dnsProviderId),
					eq(dnsProvider.organizationId, org),
				),
			});
			if (!provider?.token)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Select a DNS provider with a valid token first",
				});
			// Resolve the zone: explicit input, else the token's first zone.
			let zoneName = input.zoneName;
			if (!zoneName) {
				const zones = await cfListZones(provider.token);
				zoneName = zones[0]?.name;
			}
			if (!zoneName)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "No DNS zone available for this provider",
				});

			const existing = await db.query.loadBalancer.findFirst({
				where: eq(loadBalancer.organizationId, org),
			});
			if (existing) {
				await db
					.update(loadBalancer)
					.set({
						dnsProviderId: input.dnsProviderId,
						zoneName,
						ttl: input.ttl ?? existing.ttl,
						// Regenerate the hostname if the zone changed.
						hostname:
							existing.zoneName === zoneName
								? existing.hostname
								: generateLbHostname(zoneName),
					})
					.where(eq(loadBalancer.organizationId, org));
			} else {
				await db.insert(loadBalancer).values({
					organizationId: org,
					hostname: generateLbHostname(zoneName),
					zoneName,
					dnsProviderId: input.dnsProviderId,
					ttl: input.ttl ?? 60,
					enabled: false,
				});
			}
			const saved = await db.query.loadBalancer.findFirst({
				where: eq(loadBalancer.organizationId, org),
			});
			return { hostname: saved?.hostname, zoneName: saved?.zoneName };
		}),

	// Toggle the health-prune DNS controller. Enable → reconcile now (create A
	// records); disable → remove the LB's A records so stale IPs don't linger.
	setLoadBalancerDnsEnabled: withPermission("server", "create")
		.input(z.object({ enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			const org = ctx.session.activeOrganizationId;
			const cfg = await db.query.loadBalancer.findFirst({
				where: eq(loadBalancer.organizationId, org),
			});
			if (!cfg)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Configure the load balancer DNS first",
				});
			await db
				.update(loadBalancer)
				.set({ enabled: input.enabled })
				.where(eq(loadBalancer.organizationId, org));
			if (input.enabled) {
				return reconcileLoadBalancerDns(org);
			}
			await clearLoadBalancerDns(org);
			return { hostname: cfg.hostname, desired: [], created: [], removed: [] };
		}),

	// Manually run the health-prune reconcile.
	reconcileLoadBalancerDns: withPermission("server", "create").mutation(
		async ({ ctx }) =>
			reconcileLoadBalancerDns(ctx.session.activeOrganizationId),
	),

	// Pool members with public IP + health (for the DNS/members view).
	getLoadBalancerNodes: withPermission("server", "read").query(
		async ({ ctx }) => resolveLbNodes(ctx.session.activeOrganizationId),
	),

	// Per-node Traefik metrics (requests, status classes, latency, rate).
	getLoadBalancerMetrics: withPermission("server", "read").query(
		async ({ ctx }) => getLoadBalancerMetrics(ctx.session.activeOrganizationId),
	),

	// Pool-wide metrics time series over a window (minutes) for the graphs.
	getLoadBalancerMetricsHistory: withPermission("server", "read")
		.input(z.object({ minutes: z.number().int().min(5).max(43200) }))
		.query(async ({ ctx, input }) =>
			getLoadBalancerMetricsHistory(
				ctx.session.activeOrganizationId,
				input.minutes,
			),
		),

	// Tail pool nodes' Traefik logs (access log + errors) from each alloc's
	// stdout/stderr via the Nomad fs API. Returns one entry per running node so
	// the UI can present a consolidated view tagged by instance. Pass `node` to
	// scope to a single instance; omit for all.
	getLoadBalancerLogs: withPermission("server", "read")
		.input(
			z.object({
				node: z.string().optional(),
				logType: z.enum(["stdout", "stderr"]).default("stdout"),
			}),
		)
		.query(async ({ ctx, input }) => {
			const cfg = await resolveNomad(ctx, undefined);
			const client = nomadClient(cfg);
			try {
				const res = await client.request(
					withNs(`/job/${TRAEFIK_HA_JOB_NAME}/allocations`, cfg.namespace),
				);
				if (!res.ok) return [] as { node: string; text: string }[];
				// biome-ignore lint/suspicious/noExplicitAny: Nomad alloc stub shape
				const allocs = (await res.json()) as any[];
				const running = allocs.filter(
					(a) =>
						a.DesiredStatus === "run" &&
						a.ClientStatus === "running" &&
						(!input.node || a.NodeName === input.node),
				);
				return Promise.all(
					running.map(async (a) => {
						try {
							const logRes = await client.request(
								`/client/fs/logs/${a.ID}?task=traefik&type=${input.logType}&plain=true&origin=end&offset=60000`,
							);
							return {
								node: a.NodeName as string,
								text: logRes.ok ? await logRes.text() : "",
							};
						} catch {
							return { node: a.NodeName as string, text: "" };
						}
					}),
				);
			} catch {
				return [] as { node: string; text: string }[];
			}
		}),

	getLoadBalancerStatus: withPermission("server", "read").query(
		async ({ ctx }) => {
			const cfg = await resolveNomad(ctx, undefined);
			const client = nomadClient(cfg);
			try {
				const res = await client.request(
					withNs(`/job/${TRAEFIK_HA_JOB_NAME}/allocations`, cfg.namespace),
				);
				if (!res.ok) return { deployed: false, members: [] };
				// biome-ignore lint/suspicious/noExplicitAny: Nomad alloc stub shape
				const allocs = (await res.json()) as any[];
				// A redeployed system job leaves old complete/lost allocs behind; only
				// the ones Nomad still wants running (DesiredStatus="run") are members.
				const live = allocs.filter((a) => a.DesiredStatus === "run");
				return {
					deployed: live.length > 0,
					members: live.map((a) => ({
						node: a.NodeName as string,
						status: a.ClientStatus as string,
					})),
				};
			} catch {
				return { deployed: false, members: [] };
			}
		},
	),

	// Browse the packs available in a Nomad Pack registry so the user can pick one
	// instead of typing a name. Adds the registry to the local cache (idempotent) and
	// enumerates the cached pack directories. Defaults to the community registry; pass
	// a registry URL (e.g. nomploy's own) to browse that.
	listNomadPacks: withPermission("server", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
				registryUrl: z.string().optional(),
			}),
		)
		.query(async ({ input }) => {
			const url =
				input.registryUrl?.trim() ||
				"github.com/hashicorp/nomad-pack-community-registry";
			// The URL is interpolated into a shell command — allow only safe chars.
			if (!/^[a-zA-Z0-9_.:/@#?=&~-]+$/.test(url)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid registry URL",
				});
			}

			// Fast path: a registry published to GitHub Pages exposes a static
			// packs.json (name/description/version/homepage for every pack).
			// github.com/<org>/<repo> → https://<org>.github.io/<repo>/api/packs.json.
			// One HTTP GET — no nomad-pack CLI on the host, no metadata.hcl parsing,
			// richer data, and works even where nomad-pack isn't installed. Falls back
			// to the host cache-scrape below for registries without the API.
			const gh = url.match(
				/^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/i,
			);
			if (gh) {
				const apiUrl = `https://${gh[1].toLowerCase()}.github.io/${gh[2]}/api/packs.json`;
				try {
					const ctl = new AbortController();
					const t = setTimeout(() => ctl.abort(), 6000);
					const res = await fetch(apiUrl, { signal: ctl.signal });
					clearTimeout(t);
					if (res.ok) {
						const data = (await res.json()) as {
							packs?: {
								name?: string;
								description?: string;
								version?: string;
								appUrl?: string;
								sourceUrl?: string;
							}[];
						};
						if (Array.isArray(data.packs) && data.packs.length > 0) {
							return data.packs
								.filter((p) => p.name)
								.map((p) => ({
									name: p.name as string,
									description: p.description ?? "",
									version: p.version ?? "",
									url: p.appUrl || p.sourceUrl || "",
								}))
								.sort((a, b) => a.name.localeCompare(b.name));
						}
					}
				} catch {
					// Unreachable / not published — fall through to the cache-scrape.
				}
			}

			const name = "nomploy-browse";
			// List each pack dir and dump its metadata.hcl so we can surface a
			// description/version/homepage in the gallery (not just a bare name).
			const cmd = `
command -v nomad-pack >/dev/null 2>&1 || { echo "__NO_PACK__"; exit 0; }
nomad-pack registry add "${name}" "${url}" >/dev/null 2>&1 || true
D=$(ls -d "$HOME/.cache/nomad/packs/${name}/"*/ 2>/dev/null | head -1)
[ -n "$D" ] || exit 0
for p in "$D"*@*/; do
  [ -d "$p" ] || continue
  b=$(basename "$p"); echo "__PACK__:\${b%@*}"
  cat "$p/metadata.hcl" 2>/dev/null || true
  echo "__END__"
done
`;
			try {
				const { stdout } = input.serverId
					? await execAsyncRemote(input.serverId, cmd)
					: await execAsync(cmd);
				if (stdout.includes("__NO_PACK__")) return [];
				// Parse the __PACK__:name … __END__ blocks; pull the first
				// description/version/url out of the pack's HCL metadata.
				const packs: {
					name: string;
					description: string;
					version: string;
					url: string;
				}[] = [];
				const seen = new Set<string>();
				const blocks = stdout.split("__PACK__:").slice(1);
				for (const block of blocks) {
					const nl = block.indexOf("\n");
					const packName = (nl === -1 ? block : block.slice(0, nl)).trim();
					if (!packName || seen.has(packName)) continue;
					seen.add(packName);
					const body = block.slice(nl + 1).split("__END__")[0] ?? "";
					const grab = (re: RegExp) => re.exec(body)?.[1]?.trim() ?? "";
					packs.push({
						name: packName,
						description: grab(/description\s*=\s*"([^"]*)"/),
						version: grab(/version\s*=\s*"([^"]*)"/),
						url: grab(/url\s*=\s*"([^"]*)"/),
					});
				}
				return packs.sort((a, b) => a.name.localeCompare(b.name));
			} catch {
				return [];
			}
		}),

	getJobScale: withPermission("server", "read")
		.input(serverInput.extend({ jobId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			const direct = await client.request(
				withNs(`/job/${input.jobId}/scale`, cfg.namespace),
			);
			if (direct.ok) return direct.json();
			const [first] = await resolvePackJobIds(cfg, input.jobId);
			if (first)
				return client.get(withNs(`/job/${first}/scale`, cfg.namespace));
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `Job ${input.jobId} not found`,
			});
		}),

	// Cluster-wide SERVICE scaling activity: merge every service job's per-group
	// scale events (Nomad's /job/:id/scale Events) into one newest-first, paginated
	// feed, plus each group's current desired/running count. This is service replica
	// scaling (the Nomad Autoscaler driving a scaling{} policy, or manual scales) —
	// distinct from node autoscaling (cluster_autoscaler groups).
	getServiceScalingActivity: withPermission("server", "read")
		.input(
			serverInput.extend({
				limit: z.number().int().min(1).max(100).optional(),
				offset: z.number().int().min(0).optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			const limit = input.limit ?? 10;
			const offset = input.offset ?? 0;
			// biome-ignore lint/suspicious/noExplicitAny: Nomad job-list/scale shapes
			const jobs = (await client.get(
				withNs("/jobs", cfg.namespace),
				// biome-ignore lint/suspicious/noExplicitAny: Nomad job-list/scale shapes
			)) as any[];
			const serviceJobs = (jobs ?? []).filter(
				(j) => j.Type === "service" && j.Status !== "dead",
			);
			const scales = await Promise.all(
				serviceJobs.map(async (j) => {
					const r = await client.request(
						withNs(`/job/${j.ID}/scale`, cfg.namespace),
					);
					// biome-ignore lint/suspicious/noExplicitAny: Nomad scale-status shape
					return r.ok ? ({ jobId: j.ID, scale: await r.json() } as any) : null;
				}),
			);
			// biome-ignore lint/suspicious/noExplicitAny: Nomad scale-status shape
			const services: any[] = [];
			// biome-ignore lint/suspicious/noExplicitAny: Nomad scale-status shape
			const allEvents: any[] = [];
			for (const s of scales) {
				if (!s?.scale?.TaskGroups) continue;
				for (const [
					group,
					g,
				] of Object.entries<// biome-ignore lint/suspicious/noExplicitAny: Nomad scale-status shape
				any>(s.scale.TaskGroups)) {
					services.push({
						jobId: s.jobId,
						group,
						desired: g.Desired,
						running: g.Running,
						healthy: g.Healthy,
					});
					for (const e of g.Events ?? []) {
						allEvents.push({
							jobId: s.jobId,
							group,
							time: e.Time,
							count: e.Count,
							previousCount: e.PreviousCount,
							message: e.Message,
							error: e.Error,
							meta: e.Meta,
						});
					}
				}
			}
			allEvents.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
			return {
				services,
				events: allEvents.slice(offset, offset + limit),
				hasMore: allEvents.length > offset + limit,
				total: allEvents.length,
			};
		}),

	// Manually scale a job's task group to `count` (Nomad's scale endpoint). The
	// autoscaler, if a scaling{} policy is present, may adjust it again later.
	scaleNomadJob: withPermission("server", "create")
		.input(
			serverInput.extend({
				jobId: z.string(),
				group: z.string(),
				count: z.number().int().min(0),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const res = await nomadClient(cfg).request(
				withNs(`/job/${input.jobId}/scale`, cfg.namespace),
				{
					method: "POST",
					body: JSON.stringify({
						Target: { Group: input.group },
						Count: input.count,
						Message: `scaled to ${input.count} from the nomploy UI`,
					}),
				},
			);
			if (!res.ok) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Scale failed: ${res.status} ${res.statusText}`,
				});
			}
			return { success: true };
		}),

	// ── Canary deployments ─────────────────────────────────────────────────────
	// The most recent deployment for a job, with its per-group canary/promotion
	// state — so the UI can show "canaries healthy, awaiting promotion" and offer
	// a Promote button when auto_promote is off (health-gated deploys).
	getLatestDeployment: withPermission("server", "read")
		.input(serverInput.extend({ jobId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const res = await nomadClient(cfg).request(
				withNs(`/job/${input.jobId}/deployment`, cfg.namespace),
			);
			// 200 with an empty body means the job has no deployment yet.
			if (!res.ok) return null;
			const text = await res.text();
			if (!text) return null;
			const d = JSON.parse(text) as {
				ID: string;
				Status: string;
				StatusDescription: string;
				TaskGroups?: Record<
					string,
					{
						DesiredCanaries?: number;
						PlacedCanaries?: string[] | null;
						Promoted?: boolean;
						HealthyAllocs?: number;
						DesiredTotal?: number;
					}
				>;
			};
			const groups = Object.entries(d.TaskGroups ?? {}).map(([name, g]) => ({
				name,
				desiredCanaries: g.DesiredCanaries ?? 0,
				placedCanaries: g.PlacedCanaries?.length ?? 0,
				promoted: g.Promoted ?? false,
				healthyAllocs: g.HealthyAllocs ?? 0,
				desiredTotal: g.DesiredTotal ?? 0,
			}));
			// A deployment awaits a manual promote when it's running and at least one
			// group has unpromoted canaries that are all healthy.
			const awaitingPromotion =
				d.Status === "running" &&
				groups.some(
					(g) =>
						g.desiredCanaries > 0 &&
						!g.promoted &&
						g.placedCanaries >= g.desiredCanaries &&
						g.healthyAllocs >= g.desiredCanaries,
				);
			// When a deployment is running but can't place its allocs, surface WHY from
			// the latest eval's placement failures — so a wedged deploy is diagnosable
			// in the UI instead of via `nomad eval status`. Common causes: no node has
			// enough memory (e.g. a canary needs a 2nd alloc on a pinned node with no
			// room), or a constraint filtered every node.
			let blockedReason: string | null = null;
			if (d.Status === "running") {
				try {
					const er = await nomadClient(cfg).request(
						withNs(`/job/${input.jobId}/evaluations`, cfg.namespace),
					);
					if (er.ok) {
						const evals = (await er.json()) as {
							CreateIndex?: number;
							FailedTGAllocs?: Record<
								string,
								{
									NodesExhausted?: number;
									DimensionExhausted?: Record<string, number> | null;
									ConstraintFiltered?: Record<string, number> | null;
								}
							> | null;
						}[];
						const latest = (evals ?? [])
							.filter(
								(e) =>
									e.FailedTGAllocs && Object.keys(e.FailedTGAllocs).length > 0,
							)
							.sort((a, b) => (b.CreateIndex ?? 0) - (a.CreateIndex ?? 0))[0];
						const f = latest?.FailedTGAllocs
							? Object.values(latest.FailedTGAllocs)[0]
							: undefined;
						if (f) {
							const parts: string[] = [];
							const dims = Object.keys(f.DimensionExhausted ?? {});
							if (dims.length)
								parts.push(`no node has enough ${dims.join(", ")}`);
							const cons = Object.keys(f.ConstraintFiltered ?? {});
							if (cons.length)
								parts.push(`every node filtered by: ${cons.join("; ")}`);
							if (!parts.length && f.NodesExhausted)
								parts.push("no node has capacity");
							if (parts.length)
								blockedReason = `Can't schedule — ${parts.join("; ")}.`;
						}
					}
				} catch {}
			}
			return {
				id: d.ID,
				status: d.Status,
				description: d.StatusDescription,
				groups,
				awaitingPromotion,
				blockedReason,
			};
		}),

	// Promote a canary deployment (all task groups). Nomad then rolls the old
	// allocations out and the canaries become the running version.
	promoteDeployment: withPermission("server", "create")
		.input(serverInput.extend({ deploymentId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const res = await nomadClient(cfg).request(
				`/deployment/promote/${input.deploymentId}`,
				{
					method: "POST",
					body: JSON.stringify({
						DeploymentID: input.deploymentId,
						All: true,
					}),
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Promote failed: ${res.status} ${detail}`,
				});
			}
			return { success: true };
		}),

	// Cancel/fail a running canary deployment — reverts to the prior version
	// (auto_revert). Used when canaries are unhealthy or the deploy is unwanted.
	failDeployment: withPermission("server", "create")
		.input(serverInput.extend({ deploymentId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const res = await nomadClient(cfg).request(
				`/deployment/fail/${input.deploymentId}`,
				{
					method: "POST",
					body: JSON.stringify({ DeploymentID: input.deploymentId }),
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Fail deployment failed: ${res.status} ${detail}`,
				});
			}
			return { success: true };
		}),

	// ── Cluster versions / upgrade readiness ───────────────────────────────────
	// Per-node Nomad/Consul versions (from node attributes) + role/leader + the
	// latest Nomad release (HashiCorp checkpoint API), so the UI can flag version
	// skew, whether an upgrade is available, and lay out a quorum-safe order. The
	// actual rolling upgrade stays a guided, one-node-at-a-time operation (drain →
	// upgrade → rejoin) rather than a blind cluster-wide sweep.
	getClusterVersions: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			const stubs: any[] = await client.get("/nodes");
			// Same source of truth as getNodeTopology: cluster.json says which overlay
			// IPs are raft servers; everything else is a worker. Derive role here so
			// the UI doesn't have to join on names (Nomad node names ≠ panel names).
			const cluster = readCluster();
			const serverWgIps = new Set(
				(cluster ? allServers(cluster) : []).map((s) => s.wgIp),
			);
			// Raft leader's overlay IP (strip the :port from status/leader).
			let leaderIp = "";
			try {
				const leader = (await client.get("/status/leader")) as string;
				leaderIp = (leader || "").split(":")[0] ?? "";
			} catch {}

			// Map overlay IP → server record, so the UI can drive an assisted upgrade
			// over that server's SSH. The control-plane hub has no server row (the
			// panel runs on it) → no serverId → upgraded manually.
			const org = ctx.session?.activeOrganizationId;
			const serverRows = org
				? await db.query.server.findMany({
						where: eq(serverTable.organizationId, org),
						columns: { serverId: true, wgIp: true },
					})
				: [];
			const serverIdByIp = new Map(
				serverRows
					.filter((s) => s.wgIp)
					.map((s) => [s.wgIp as string, s.serverId]),
			);

			const nodes = await Promise.all(
				stubs.map(async (n: any) => {
					let nomadVersion: string | null = null;
					let consulVersion: string | null = null;
					let isControlPlane = false;
					try {
						const detail: any = await client.get(`/node/${n.ID}`);
						const attrs = detail.Attributes || {};
						nomadVersion = attrs["nomad.version"] ?? null;
						consulVersion = attrs["consul.version"] ?? null;
						isControlPlane = detail.Meta?.nomploy_control_plane === "true";
					} catch {}
					// n.Address is the node's overlay (WireGuard) IP.
					const role: "server" | "worker" =
						isControlPlane || serverWgIps.has(n.Address) ? "server" : "worker";
					return {
						name: n.Name as string,
						status: n.Status as string,
						nomadVersion,
						consulVersion,
						role,
						isLeader: !!n.Address && n.Address === leaderIp,
						// null for the hub (no server row) → manual upgrade.
						serverId: serverIdByIp.get(n.Address) ?? null,
						// The control-plane hub can't be upgraded by the panel (it runs
						// inside a container without host apt/systemd access) → the UI
						// shows a manual `apt`+restart step instead of an Upgrade button.
						isControlPlane,
					};
				}),
			);

			// Latest stable Nomad, best-effort. Never fail the query on a network hiccup.
			let latestNomad: string | null = null;
			try {
				const r = await fetch(
					"https://checkpoint-api.hashicorp.com/v1/check/nomad",
					{ signal: AbortSignal.timeout(5000) },
				);
				if (r.ok) {
					const j = (await r.json()) as { current_version?: string };
					latestNomad = j.current_version ?? null;
				}
			} catch {}

			const running = [
				...new Set(nodes.map((n) => n.nomadVersion).filter(Boolean)),
			] as string[];
			return {
				nodes,
				latestNomad,
				// Nodes disagree on Nomad version — a rolling upgrade left half-done.
				skew: running.length > 1,
				// Every node is on the latest release.
				upToDate:
					!!latestNomad && running.length === 1 && running[0] === latestNomad,
			};
		}),

	// Assisted upgrade of one node's Nomad package over its SSH connection. Only
	// restarts the agent if apt actually upgraded the package (so running it with
	// nothing newer available is a safe no-op — no gratuitous scheduler restart).
	// The control-plane hub has no server record (the panel runs on it) so it is
	// not upgradable here — upgrade it manually. Callers drive one node at a time
	// in quorum-safe order (workers, then followers, leader last).
	upgradeNode: withPermission("server", "create")
		.input(z.object({ serverId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const server = await findServerById(input.serverId);
			if (server.organizationId !== ctx.session?.activeOrganizationId) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
			// $before/$after are shell vars; \${Version} is a literal dpkg format
			// string (escaped so JS doesn't interpolate it).
			const cmd = `set -e
before=$(dpkg-query -W -f='\${Version}' nomad 2>/dev/null || echo none)
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade nomad
after=$(dpkg-query -W -f='\${Version}' nomad 2>/dev/null || echo none)
if [ "$before" != "$after" ]; then
  systemctl restart nomad
  echo "UPGRADED nomad $before -> $after (agent restarted)"
else
  echo "NOOP nomad already at $after (no restart)"
fi`;
			const { stdout, stderr } = await execAsyncRemote(input.serverId, cmd);
			const output = `${stdout}${stderr}`.trim();
			return {
				success: true,
				changed: /^UPGRADED/m.test(output),
				output: output.slice(-4000),
			};
		}),

	// ── Version history / rollback ─────────────────────────────────────────────
	// Nomad keeps every submitted version of a job. This lists them so the UI can
	// show a deploy history and offer an instant one-click revert to a prior spec
	// (image + env + resources), with no rebuild.
	getJobVersions: withPermission("server", "read")
		.input(serverInput.extend({ jobId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			// A Nomad Pack's job id != appName — fall back to the pack's real job id.
			let res = await client.request(
				withNs(`/job/${input.jobId}/versions`, cfg.namespace),
			);
			if (!res.ok) {
				const [first] = await resolvePackJobIds(cfg, input.jobId);
				if (first)
					res = await client.request(
						withNs(`/job/${first}/versions`, cfg.namespace),
					);
			}
			if (!res.ok) return [];
			const body = (await res.json()) as {
				Versions?: Array<{
					Version: number;
					SubmitTime?: number;
					Stable?: boolean;
					TaskGroups?: Array<{
						Tasks?: Array<{ Config?: { image?: string } }>;
					}>;
				}>;
			};
			const versions = body.Versions ?? [];
			// Highest version number is what's running now.
			const current = versions.reduce((m, v) => Math.max(m, v.Version), 0);
			return versions
				.map((v) => ({
					version: v.Version,
					// Nomad SubmitTime is unix nanoseconds.
					submitTime: v.SubmitTime
						? Math.round(v.SubmitTime / 1_000_000)
						: null,
					stable: v.Stable ?? false,
					current: v.Version === current,
					image: v.TaskGroups?.[0]?.Tasks?.[0]?.Config?.image ?? null,
				}))
				.sort((a, b) => b.version - a.version);
		}),

	// Revert a job to a prior version — Nomad re-submits that version's spec as a
	// new deployment (auto_revert / health checks still apply on the way in).
	revertJob: withPermission("server", "create")
		.input(serverInput.extend({ jobId: z.string(), version: z.number().int() }))
		.mutation(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			// A Nomad Pack's job id != appName — resolve the pack's real job id.
			let jobId = input.jobId;
			const probe = await client.request(
				withNs(`/job/${jobId}/versions`, cfg.namespace),
			);
			if (!probe.ok) {
				const [first] = await resolvePackJobIds(cfg, input.jobId);
				if (first) jobId = first;
			}
			const res = await client.request(
				withNs(`/job/${jobId}/revert`, cfg.namespace),
				{
					method: "POST",
					body: JSON.stringify({ JobID: jobId, JobVersion: input.version }),
				},
			);
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Revert failed: ${res.status} ${detail}`,
				});
			}
			return { success: true };
		}),

	getAllocations: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			return nomadClient(cfg).get(withNs("/allocations", cfg.namespace));
		}),

	getAllocation: withPermission("server", "read")
		.input(serverInput.extend({ allocId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			return nomadClient(cfg).get(`/allocation/${input.allocId}`);
		}),

	getAllocationLogs: withPermission("server", "read")
		.input(
			serverInput.extend({
				allocId: z.string(),
				taskName: z.string(),
				logType: z.enum(["stdout", "stderr"]).default("stdout"),
			}),
		)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const res = await nomadClient(cfg).request(
				`/client/fs/logs/${input.allocId}?task=${input.taskName}&type=${input.logType}&plain=true`,
			);
			if (!res.ok) return "";
			return res.text();
		}),

	getNodes: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			return nomadClient(cfg).get("/nodes");
		}),

	// Per-node capacity + what's actually allocated ON THAT node. The nodes table
	// used the cluster-wide totals for every row (so every node showed the same
	// %); this returns each node's own numbers by reading its /node/:id detail
	// (NodeResources) and summing only the allocations placed on it.
	getNodesWithResources: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			const nodes: any[] = await client.get("/nodes");
			const allocs: any[] = await client.get(
				withNs("/allocations?resources=true", cfg.namespace),
			);
			// Canonical display name per node (cluster.json), keyed by overlay IP —
			// same mapping as getClusterMembers/getNodeTopology so every node view
			// shows the same name instead of the raw Nomad hostname.
			const cluster = readCluster();
			const nameByWgIp = new Map<string, string>();
			if (cluster) {
				nameByWgIp.set(cluster.hubWgIp, "control-plane");
				for (const s of cluster.servers || []) nameByWgIp.set(s.wgIp, s.name);
				for (const p of cluster.peers || []) nameByWgIp.set(p.wgIp, p.name);
			}

			return Promise.all(
				nodes.map(async (node: any) => {
					let cpuTotal = 0;
					let memTotal = 0;
					try {
						const detail: any = await client.get(`/node/${node.ID}`);
						const res = detail.NodeResources || {};
						cpuTotal = res.Cpu?.CpuShares || 0;
						memTotal = res.Memory?.MemoryMB || 0;
					} catch {}

					let cpuAllocated = 0;
					let memAllocated = 0;
					let allocCount = 0;
					for (const alloc of allocs) {
						if (alloc.NodeID !== node.ID) continue;
						if (alloc.ClientStatus !== "running") continue;
						allocCount++;
						const tasks = alloc.AllocatedResources?.Tasks || {};
						for (const task of Object.values(tasks) as any[]) {
							cpuAllocated += task?.Cpu?.CpuShares || 0;
							memAllocated += task?.Memory?.MemoryMB || 0;
						}
					}

					return {
						ID: node.ID as string,
						Name: nameByWgIp.get(node.Address) ?? (node.Name as string),
						Status: node.Status as string,
						Datacenter: node.Datacenter as string,
						allocCount,
						cpu: { total: cpuTotal, allocated: cpuAllocated },
						memory: { total: memTotal, allocated: memAllocated },
					};
				}),
			);
		}),

	// Per-node infrastructure view: each node's size (CPU/mem capacity), role, and
	// the list of allocations actually running on it — powers the Infrastructure
	// topology graph ("what's running on which node").
	getNodeTopology: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			const nodes: any[] = await client.get("/nodes");
			const allocs: any[] = await client.get(
				withNs("/allocations?resources=true", cfg.namespace),
			);
			// Distinguish HA servers (raft) from plain workers — both run as Nomad
			// clients, so /v1/nodes lists them identically. cluster.json is the source
			// of truth: allServers() = hub + HA servers, peers = workers.
			const cluster = readCluster();
			const serverWgIps = new Set(
				(cluster ? allServers(cluster) : []).map((s) => s.wgIp),
			);
			// Canonical display name per node, keyed by overlay (WireGuard) IP —
			// the SAME source of truth as getClusterMembers (cluster.json). Without
			// this the topology cards show the raw Nomad node name (the OS hostname,
			// e.g. "nomploy4") while the members table shows the mesh name
			// ("nomad-server-2"), so the two views disagree about the same box.
			const nameByWgIp = new Map<string, string>();
			if (cluster) {
				nameByWgIp.set(cluster.hubWgIp, "control-plane");
				for (const s of cluster.servers || []) nameByWgIp.set(s.wgIp, s.name);
				for (const p of cluster.peers || []) nameByWgIp.set(p.wgIp, p.name);
			}

			return Promise.all(
				nodes.map(async (node: any) => {
					let cpuTotal = 0;
					let memTotal = 0;
					let isControlPlane = false;
					try {
						const detail: any = await client.get(`/node/${node.ID}`);
						const res = detail.NodeResources || {};
						cpuTotal = res.Cpu?.CpuShares || 0;
						memTotal = res.Memory?.MemoryMB || 0;
						isControlPlane = detail.Meta?.nomploy_control_plane === "true";
					} catch {}
					// node.Address is the node's overlay (WireGuard) IP.
					const role = isControlPlane
						? "control-plane"
						: serverWgIps.has(node.Address)
							? "server"
							: "worker";

					let cpuAllocated = 0;
					let memAllocated = 0;
					const nodeAllocs: {
						id: string;
						jobId: string;
						taskGroup: string;
						name: string;
						cpu: number;
						memory: number;
					}[] = [];
					for (const alloc of allocs) {
						if (alloc.NodeID !== node.ID) continue;
						if (alloc.ClientStatus !== "running") continue;
						let aCpu = 0;
						let aMem = 0;
						const tasks = alloc.AllocatedResources?.Tasks || {};
						for (const task of Object.values(tasks) as any[]) {
							aCpu += task?.Cpu?.CpuShares || 0;
							aMem += task?.Memory?.MemoryMB || 0;
						}
						cpuAllocated += aCpu;
						memAllocated += aMem;
						nodeAllocs.push({
							id: alloc.ID as string,
							jobId: alloc.JobID as string,
							taskGroup: alloc.TaskGroup as string,
							name: alloc.Name as string,
							cpu: aCpu,
							memory: aMem,
						});
					}
					nodeAllocs.sort((a, b) => a.jobId.localeCompare(b.jobId));

					return {
						ID: node.ID as string,
						// Prefer the canonical mesh name (cluster.json) over the raw Nomad
						// node name so the topology matches the members table; fall back to
						// the Nomad hostname for a node not (yet) in cluster.json.
						Name: nameByWgIp.get(node.Address) ?? (node.Name as string),
						Status: node.Status as string,
						Datacenter: node.Datacenter as string,
						drain: !!node.Drain,
						eligibility: node.SchedulingEligibility as string,
						isControlPlane,
						role,
						nodePool: (node.NodePool as string) || "default",
						cpu: { total: cpuTotal, allocated: cpuAllocated },
						memory: { total: memTotal, allocated: memAllocated },
						allocs: nodeAllocs,
					};
				}),
			);
		}),

	// Live (actual) per-node resource usage from Nomad's client-stats API — the
	// real-time complement to getNodeTopology's reservations. Poll on an interval.
	getClusterMetrics: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			const nodes: any[] = await client.get("/nodes");
			const ready = nodes.filter((n: any) => n.Status === "ready");
			return Promise.all(
				ready.map(async (n: any) => {
					try {
						const s: any = await client.get(`/client/stats?node_id=${n.ID}`);
						const cores: any[] = s.CPU || [];
						const cpuPercent = cores.length
							? Math.round(
									cores.reduce(
										(a: number, c: any) => a + (c.TotalPercent || 0),
										0,
									) / cores.length,
								)
							: 0;
						const memTotal = s.Memory?.Total || 0;
						const memUsed = s.Memory?.Used || 0;
						return {
							nodeId: n.ID as string,
							name: n.Name as string,
							ok: true,
							cpuPercent,
							memUsedMB: Math.round(memUsed / 1048576),
							memTotalMB: Math.round(memTotal / 1048576),
							memPercent: memTotal ? Math.round((memUsed / memTotal) * 100) : 0,
						};
					} catch {
						// A node whose client API is unreachable (draining, down) — report
						// it as unavailable rather than failing the whole query.
						return {
							nodeId: n.ID as string,
							name: n.Name as string,
							ok: false,
							cpuPercent: 0,
							memUsedMB: 0,
							memTotalMB: 0,
							memPercent: 0,
						};
					}
				}),
			);
		}),

	// Live per-allocation usage: actual CPU (MHz) and memory (bytes) a running
	// allocation is consuming right now, versus what it reserved. The real-time
	// drill-down complement to getClusterMetrics (node-level) — answers "is this
	// one app actually using what it asked for". Reserved comes from the alloc's
	// AllocatedResources (summed across its tasks).
	getAllocationMetrics: withPermission("server", "read")
		.input(serverInput.extend({ allocId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			try {
				const [stats, alloc] = await Promise.all([
					client.get(
						`/client/allocation/${input.allocId}/stats`,
					) as Promise<any>,
					client.get(`/allocation/${input.allocId}`) as Promise<any>,
				]);
				// Reserved: sum CpuShares (MHz) + MemoryMB across the alloc's tasks.
				const tasks = alloc?.AllocatedResources?.Tasks || {};
				let reservedMhz = 0;
				let reservedMB = 0;
				for (const t of Object.values(tasks) as any[]) {
					reservedMhz += t?.Cpu?.CpuShares || 0;
					reservedMB += t?.Memory?.MemoryMB || 0;
				}
				const usedMhz = Math.round(
					stats?.ResourceUsage?.CpuStats?.TotalTicks || 0,
				);
				const usedBytes = stats?.ResourceUsage?.MemoryStats?.Usage || 0;
				const usedMB = Math.round(usedBytes / 1048576);
				// Some Nomad clients (e.g. cgroup-v2 hosts where the driver doesn't
				// publish per-task stats) return a 200 with all-zero usage. A running
				// container always uses some memory, so all-zero means "not collected"
				// — report unavailable rather than draw misleading 0% bars.
				if (usedMhz === 0 && usedMB === 0) {
					return {
						allocId: input.allocId,
						ok: false,
						cpu: { usedMhz: 0, reservedMhz: 0, percent: 0 },
						memory: { usedMB: 0, reservedMB: 0, percent: 0 },
					};
				}
				return {
					allocId: input.allocId,
					ok: true,
					cpu: {
						usedMhz,
						reservedMhz,
						percent: reservedMhz
							? Math.round((usedMhz / reservedMhz) * 100)
							: 0,
					},
					memory: {
						usedMB,
						reservedMB,
						percent: reservedMB ? Math.round((usedMB / reservedMB) * 100) : 0,
					},
				};
			} catch {
				// Alloc not running, node unreachable, or stats not yet available.
				return {
					allocId: input.allocId,
					ok: false,
					cpu: { usedMhz: 0, reservedMhz: 0, percent: 0 },
					memory: { usedMB: 0, reservedMB: 0, percent: 0 },
				};
			}
		}),

	// ── App secrets (Nomad Variables) ─────────────────────────────────────────
	// Secrets live in the Nomad Variable nomad/jobs/<appName>, injected into the
	// task as env via a template block (see generateSecretsTemplate). The values
	// never touch the job HCL. First enable requires a redeploy to add the
	// template; after that, updates roll the task automatically (change_mode).

	getAppSecrets: protectedProcedure
		.input(z.object({ applicationId: z.string() }))
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				envVars: ["read"],
			});
			const application = await findApplicationById(input.applicationId);
			const cfg = await resolveNomad(ctx, application.serverId ?? undefined);
			const res = await nomadClient(cfg).request(
				withNs(`/var/nomad/jobs/${application.appName}`, cfg.namespace),
			);
			if (res.status === 404) {
				return {
					items: {} as Record<string, string>,
					enabled: application.nomadSecretsEnabled,
				};
			}
			if (!res.ok) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Nomad variable read failed: ${res.status} ${res.statusText}`,
				});
			}
			const v = (await res.json()) as { Items?: Record<string, string> };
			// Config-file content shares this variable under nmplcfg_* keys (see
			// setAppConfigFiles) — never surface those as env secrets.
			const items = Object.fromEntries(
				Object.entries(v.Items ?? {}).filter(
					([k]) => !k.startsWith(CONFIG_FILE_PREFIX),
				),
			);
			return {
				items,
				enabled: application.nomadSecretsEnabled,
			};
		}),

	// Replace the whole secret set (like saveEnvironment). Empty = delete the
	// variable and disable the template. Flips nomadSecretsEnabled so the builder
	// knows whether to emit the secrets template on the next deploy.
	setAppSecrets: protectedProcedure
		.input(
			z.object({
				applicationId: z.string(),
				items: z.record(z.string(), z.string()),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				envVars: ["write"],
			});
			const application = await findApplicationById(input.applicationId);
			const cfg = await resolveNomad(ctx, application.serverId ?? undefined);
			const client = nomadClient(cfg);
			const path = `/var/nomad/jobs/${application.appName}`;
			const keys = Object.keys(input.items);

			// Read-modify-write: the same variable also holds config-file content
			// (nmplcfg_* keys, see setAppConfigFiles). Replace only the secret keys
			// (everything NOT nmplcfg_*) and preserve the config-file keys, so saving
			// secrets never wipes config files (and vice versa).
			const existing = await readVariableItems(client, path, cfg.namespace);
			const preserved = Object.fromEntries(
				Object.entries(existing).filter(([k]) =>
					k.startsWith(CONFIG_FILE_PREFIX),
				),
			);
			const merged = { ...preserved, ...input.items };

			await writeOrDeleteVariable(
				client,
				path,
				`nomad/jobs/${application.appName}`,
				merged,
				cfg.namespace,
			);
			await updateApplication(input.applicationId, {
				nomadSecretsEnabled: keys.length > 0,
			});

			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return { enabled: keys.length > 0, count: keys.length };
		}),

	// ── App config files (Nomad Variables → mounted files) ────────────────────
	// Like secrets, but each file's content is rendered to a FILE inside the
	// container (env=false) and docker-mounted at its mountPath, instead of
	// injected as env. Content lives in the same variable (nomad/jobs/<appName>)
	// under nmplcfg_<i> keys; the mount metadata (mountPath + varKey) lives in
	// application.configFiles so the builder knows what to render. First enable
	// needs a redeploy to add the template; after that, edits roll the task.
	getAppConfigFiles: protectedProcedure
		.input(z.object({ applicationId: z.string() }))
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				envVars: ["read"],
			});
			const application = await findApplicationById(input.applicationId);
			const cfg = await resolveNomad(ctx, application.serverId ?? undefined);
			const items = await readVariableItems(
				nomadClient(cfg),
				`/var/nomad/jobs/${application.appName}`,
				cfg.namespace,
			);
			// Join Postgres metadata (ordered mountPaths + varKeys) with the
			// content from the variable. Skip any whose content vanished.
			const files = (application.configFiles ?? []).map((f) => ({
				mountPath: f.mountPath,
				content: items[f.varKey] ?? "",
			}));
			return { files, enabled: (application.configFiles ?? []).length > 0 };
		}),

	setAppConfigFiles: protectedProcedure
		.input(
			z.object({
				applicationId: z.string(),
				files: z.array(
					z.object({
						mountPath: z.string(),
						content: z.string(),
					}),
				),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				envVars: ["write"],
			});
			const application = await findApplicationById(input.applicationId);
			const cfg = await resolveNomad(ctx, application.serverId ?? undefined);
			const client = nomadClient(cfg);
			const path = `/var/nomad/jobs/${application.appName}`;

			// Read-modify-write, preserving the secret keys (everything NOT
			// nmplcfg_*). Drop the old config-file keys and rewrite them from the
			// submitted list; blank mountPaths are ignored.
			const existing = await readVariableItems(client, path, cfg.namespace);
			const merged: Record<string, string> = Object.fromEntries(
				Object.entries(existing).filter(
					([k]) => !k.startsWith(CONFIG_FILE_PREFIX),
				),
			);
			const configFiles: { mountPath: string; varKey: string }[] = [];
			input.files.forEach((f) => {
				if (!f.mountPath.trim()) return;
				const varKey = `${CONFIG_FILE_PREFIX}${configFiles.length}`;
				merged[varKey] = f.content;
				configFiles.push({ mountPath: f.mountPath.trim(), varKey });
			});

			await writeOrDeleteVariable(
				client,
				path,
				`nomad/jobs/${application.appName}`,
				merged,
				cfg.namespace,
			);
			await updateApplication(input.applicationId, { configFiles });

			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return { enabled: configFiles.length > 0, count: configFiles.length };
		}),

	// ── Compose secrets + config files (compose-wide) ──────────────────────────
	// Same Nomad-Variable model as the app handlers, but applied to a WHOLE
	// compose: the secrets/config files are injected into EVERY service (all read
	// the shared job variable nomad/jobs/<compose.appName>). See the injection in
	// generateNomadJob's compose path.
	getComposeSecrets: protectedProcedure
		.input(z.object({ composeId: z.string() }))
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				envVars: ["read"],
			});
			const compose = await findComposeById(input.composeId);
			const cfg = await resolveNomad(ctx, compose.serverId ?? undefined);
			const res = await nomadClient(cfg).request(
				withNs(`/var/nomad/jobs/${compose.appName}`, cfg.namespace),
			);
			if (res.status === 404) {
				return {
					items: {} as Record<string, string>,
					enabled: compose.nomadSecretsEnabled,
				};
			}
			if (!res.ok) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Nomad variable read failed: ${res.status} ${res.statusText}`,
				});
			}
			const v = (await res.json()) as { Items?: Record<string, string> };
			const items = Object.fromEntries(
				Object.entries(v.Items ?? {}).filter(
					([k]) => !k.startsWith(CONFIG_FILE_PREFIX),
				),
			);
			return { items, enabled: compose.nomadSecretsEnabled };
		}),

	setComposeSecrets: protectedProcedure
		.input(
			z.object({
				composeId: z.string(),
				items: z.record(z.string(), z.string()),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				envVars: ["write"],
			});
			const compose = await findComposeById(input.composeId);
			const cfg = await resolveNomad(ctx, compose.serverId ?? undefined);
			const client = nomadClient(cfg);
			const path = `/var/nomad/jobs/${compose.appName}`;
			const keys = Object.keys(input.items);
			const existing = await readVariableItems(client, path, cfg.namespace);
			const preserved = Object.fromEntries(
				Object.entries(existing).filter(([k]) =>
					k.startsWith(CONFIG_FILE_PREFIX),
				),
			);
			const merged = { ...preserved, ...input.items };
			await writeOrDeleteVariable(
				client,
				path,
				`nomad/jobs/${compose.appName}`,
				merged,
				cfg.namespace,
			);
			await updateCompose(input.composeId, {
				nomadSecretsEnabled: keys.length > 0,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: compose.composeId,
				resourceName: compose.appName,
			});
			return { enabled: keys.length > 0, count: keys.length };
		}),

	getComposeConfigFiles: protectedProcedure
		.input(z.object({ composeId: z.string() }))
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				envVars: ["read"],
			});
			const compose = await findComposeById(input.composeId);
			const cfg = await resolveNomad(ctx, compose.serverId ?? undefined);
			const items = await readVariableItems(
				nomadClient(cfg),
				`/var/nomad/jobs/${compose.appName}`,
				cfg.namespace,
			);
			const files = (compose.configFiles ?? []).map((f) => ({
				mountPath: f.mountPath,
				content: items[f.varKey] ?? "",
			}));
			return { files, enabled: (compose.configFiles ?? []).length > 0 };
		}),

	setComposeConfigFiles: protectedProcedure
		.input(
			z.object({
				composeId: z.string(),
				files: z.array(
					z.object({ mountPath: z.string(), content: z.string() }),
				),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				envVars: ["write"],
			});
			const compose = await findComposeById(input.composeId);
			const cfg = await resolveNomad(ctx, compose.serverId ?? undefined);
			const client = nomadClient(cfg);
			const path = `/var/nomad/jobs/${compose.appName}`;
			const existing = await readVariableItems(client, path, cfg.namespace);
			const merged: Record<string, string> = Object.fromEntries(
				Object.entries(existing).filter(
					([k]) => !k.startsWith(CONFIG_FILE_PREFIX),
				),
			);
			const configFiles: { mountPath: string; varKey: string }[] = [];
			input.files.forEach((f) => {
				if (!f.mountPath.trim()) return;
				const varKey = `${CONFIG_FILE_PREFIX}${configFiles.length}`;
				merged[varKey] = f.content;
				configFiles.push({ mountPath: f.mountPath.trim(), varKey });
			});
			await writeOrDeleteVariable(
				client,
				path,
				`nomad/jobs/${compose.appName}`,
				merged,
				cfg.namespace,
			);
			await updateCompose(input.composeId, { configFiles });
			await audit(ctx, {
				action: "update",
				resourceType: "compose",
				resourceId: compose.composeId,
				resourceName: compose.appName,
			});
			return { enabled: configFiles.length > 0, count: configFiles.length };
		}),

	getClusterResources: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			const nodes: any[] = await client.get("/nodes");
			const allocs: any[] = await client.get(
				withNs("/allocations?resources=true", cfg.namespace),
			);

			let totalCpu = 0;
			let totalMemory = 0;
			let totalDisk = 0;
			let allocatedCpu = 0;
			let allocatedMemory = 0;
			let runningAllocs = 0;
			const totalAllocs = allocs.length;

			for (const node of nodes) {
				if (node.Status !== "ready") continue;
				try {
					const detail: any = await client.get(`/node/${node.ID}`);
					const res = detail.NodeResources || {};
					totalCpu += res.Cpu?.CpuShares || 0;
					totalMemory += res.Memory?.MemoryMB || 0;
					totalDisk += res.Disk?.DiskMB || 0;
				} catch {}
			}

			for (const alloc of allocs) {
				if (alloc.ClientStatus !== "running") continue;
				runningAllocs++;
				const tasks = alloc.AllocatedResources?.Tasks || {};
				for (const task of Object.values(tasks) as any[]) {
					allocatedCpu += task?.Cpu?.CpuShares || 0;
					allocatedMemory += task?.Memory?.MemoryMB || 0;
				}
			}

			return {
				nodes: nodes.length,
				nodesReady: nodes.filter((n: any) => n.Status === "ready").length,
				cpu: {
					total: totalCpu,
					allocated: allocatedCpu,
					free: totalCpu - allocatedCpu,
				},
				memory: {
					total: totalMemory,
					allocated: allocatedMemory,
					free: totalMemory - allocatedMemory,
				},
				disk: { total: totalDisk },
				allocations: { running: runningAllocs, total: totalAllocs },
			};
		}),

	getNode: withPermission("server", "read")
		.input(serverInput.extend({ nodeId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			return nomadClient(cfg).get(`/node/${input.nodeId}`);
		}),

	// Consul service catalog with per-service health, as the native Consul UI
	// shows it (one call to the internal UI endpoint). Read-only.
	getConsulServices: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveConsul(ctx, input.serverId);
			const services: any[] = await consulGet(cfg, "/internal/ui/services");
			return services.map((s) => ({
				name: s.Name as string,
				tags: (s.Tags || []) as string[],
				instances: (s.InstanceCount ?? s.Nodes?.length ?? 0) as number,
				checksPassing: (s.ChecksPassing || 0) as number,
				checksWarning: (s.ChecksWarning || 0) as number,
				checksCritical: (s.ChecksCritical || 0) as number,
				kind: (s.Kind || "") as string,
				datacenter: (s.Datacenter || "") as string,
			}));
		}),

	// Consul cluster members (servers + clients) with health, for the Consul tab.
	getConsulNodes: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveConsul(ctx, input.serverId);
			const nodes: any[] = await consulGet(cfg, "/internal/ui/nodes");
			return nodes.map((n) => ({
				node: n.Node as string,
				address: n.Address as string,
				status: (n.Checks?.every((c: any) => c.Status === "passing")
					? "passing"
					: n.Checks?.some((c: any) => c.Status === "critical")
						? "critical"
						: "warning") as string,
				services: (n.Services?.length ?? 0) as number,
			}));
		}),

	scaleJob: withPermission("server", "create")
		.input(
			serverInput.extend({
				jobId: z.string(),
				group: z.string(),
				count: z.number().min(0),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const res = await nomadClient(cfg).request(
				withNs(`/job/${input.jobId}/scale`, cfg.namespace),
				{
					method: "POST",
					body: JSON.stringify({
						Count: input.count,
						Target: { Group: input.group },
					}),
				},
			);
			if (!res.ok) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Scale failed: ${res.status}`,
				});
			}
			return res.json();
		}),

	stopJob: withPermission("server", "create")
		.input(
			serverInput.extend({
				jobId: z.string(),
				purge: z.boolean().default(false),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const res = await nomadClient(cfg).request(
				withNs(`/job/${input.jobId}?purge=${input.purge}`, cfg.namespace),
				{ method: "DELETE" },
			);
			if (!res.ok) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Stop failed: ${res.status}`,
				});
			}
			return res.json();
		}),

	// Install Docker + Consul + Nomad + CNI on a server over SSH, streaming logs.
	bootstrapServer: withPermission("server", "create")
		.input(z.object({ serverId: z.string() }))
		.subscription(async ({ input, ctx }) => {
			const server = await findServerById(input.serverId);
			if (server.organizationId !== ctx.session?.activeOrganizationId) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}

			const command = getNomadBootstrapCommand({
				datacenter: server.nomadNamespace || "dc1",
			});

			return observable<string>((emit) => {
				execAsyncRemote(input.serverId, command, (log) => emit.next(log))
					.then(async () => {
						// Point the control plane at this server's Nomad if not set yet.
						if (!server.nomadAddress) {
							const address = `http://${server.ipAddress}:4646`;
							await updateServerById(input.serverId, { nomadAddress: address });
							emit.next(`\nSaved Nomad address: ${address} ✅\n`);
						}
						emit.next("BOOTSTRAP_DONE");
						emit.complete();
					})
					.catch((err: unknown) => {
						const message =
							err instanceof Error ? err.message : "Bootstrap failed";
						emit.next(`\n❌ ${message}\n`);
						emit.next(OP_ENDED);
						emit.complete();
					});
			});
		}),

	// Join a node to the cluster over the WireGuard mesh as a worker (Nomad/Consul
	// client) or a server (adds Nomad/Consul raft quorum). Installs + configures
	// it, then registers its WireGuard peer on the existing members. Streams logs.
	joinCluster: withPermission("server", "create")
		.input(
			z.object({
				serverId: z.string(),
				role: z.enum(["server", "worker"]).default("worker"),
				// Which Nomad node pool a WORKER joins (an autoscaling group's pool, or
				// a new pool name). Defaults to "default". Ignored for server nodes.
				nodePool: z.string().optional(),
			}),
		)
		.subscription(async ({ input, ctx }) => {
			const server = await findServerById(input.serverId);
			if (server.organizationId !== ctx.session?.activeOrganizationId) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}

			// Guard against the crossed/duplicate membership that repeated joins + IP
			// reuse produce. Re-joining an existing member allocates a SECOND overlay IP
			// (the box keeps its old one) → the DB wgIp and the box diverge, and the live
			// node gets misattributed to the wrong row. And when a destroyed VM's private
			// IP is reused by a new box, a second row with the same IP appears. Refuse
			// both up front and tell the operator to remove the stale member first.
			if (server.clusterRole) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `"${server.name}" is already a ${server.clusterRole} in the cluster. Remove it first before re-joining — re-joining allocates a second overlay IP and corrupts the membership records.`,
				});
			}
			const orgId = ctx.session.activeOrganizationId;
			if (orgId) {
				const members = await db.query.server.findMany({
					where: eq(serverTable.organizationId, orgId),
				});
				const dupIpMember = members.find(
					(s) =>
						s.serverId !== server.serverId &&
						s.ipAddress === server.ipAddress &&
						!!s.clusterRole,
				);
				if (dupIpMember) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `${server.ipAddress} already belongs to cluster member "${dupIpMember.name}". A destroyed VM's private IP was likely reused without removing the old node — remove "${dupIpMember.name}" first, then re-join.`,
					});
				}
			}

			return observable<string>((emit) => {
				(async () => {
					try {
						const cluster = readCluster();
						if (!cluster) {
							emit.next(
								"❌ Cluster not initialized on the control plane (missing /etc/nomploy/cluster.json).\n",
							);
							emit.next(OP_ENDED);
							emit.complete();
							return;
						}
						const overlayCidr = cluster.overlayCidr || "10.10.0.0/24";

						// Fail fast with actionable guidance if we can't SSH in yet.
						if (!(await preflightNode(emit, server))) return;

						if (input.role === "server") {
							const wgIp = allocateWgIp(cluster, "server");
							emit.next(
								`Assigning server overlay IP ${wgIp} to "${server.name}"\n`,
							);
							const servers = allServers(cluster);
							const script = getClusterServerJoinCommand({
								ownWgIp: wgIp,
								gossipKey: cluster.gossipKey,
								bootstrapExpect: Math.min(servers.length + 1, 3),
								serverWgIps: [...servers.map((s) => s.wgIp), wgIp],
								otherServers: servers.map((s) => ({
									wgIp: s.wgIp,
									publicKey: s.publicKey,
									endpoint: s.endpoint,
								})),
								existingWorkers: cluster.peers.map((p) => ({
									wgIp: p.wgIp,
									publicKey: p.publicKey,
								})),
								overlayCidr,
								aclTokens: readClusterAclTokens(),
							});
							let pubkey = "";
							await execAsyncRemote(input.serverId, script, (log) => {
								emit.next(log);
								const cap = log.match(/SERVER_WG_PUBKEY=(\S+)/)?.[1];
								if (cap) pubkey = cap.trim();
							});
							if (!pubkey) {
								emit.next("\n❌ Did not receive the server's WireGuard key\n");
								emit.next(OP_ENDED);
								emit.complete();
								return;
							}
							const endpoint = `${server.ipAddress}:51820`;
							emit.next(
								`\nRegistering WireGuard peer on all members (${wgIp})\n`,
							);
							await addPeerEverywhere(
								{ wgIp, publicKey: pubkey, endpoint },
								allMeshMembers(cluster).filter(
									(m) => m.serverId !== input.serverId,
								),
								(l) => emit.next(l),
							);
							cluster.servers = cluster.servers || [];
							cluster.servers.push({
								wgIp,
								publicKey: pubkey,
								serverId: input.serverId,
								name: server.name,
								endpoint,
							});
							writeCluster(cluster);
							await updateServerById(input.serverId, {
								nomadAddress: `http://${wgIp}:4646`,
								clusterRole: "server",
								wgIp,
								wgPublicKey: pubkey,
							});
							emit.next(
								"\nServer joined. Raft grows via retry_join; peers persist in raft state across restarts.\n",
							);
							emit.next("JOIN_DONE");
							emit.complete();
							return;
						}

						// worker
						const wgIp = allocateWgIp(cluster, "worker");
						emit.next(
							`Assigning worker overlay IP ${wgIp} to "${server.name}"\n`,
						);
						// Which node pool this worker joins. A non-default pool must EXIST
						// before the client registers into it, so create it eagerly (Nomad
						// also auto-creates on join, but this keeps it visible + targetable).
						const nodePool =
							input.nodePool && input.nodePool !== "default"
								? input.nodePool
								: undefined;
						if (nodePool) {
							emit.next(`Ensuring Nomad node pool "${nodePool}" exists\n`);
							try {
								const cfg = await resolveNomad(ctx, undefined);
								await nomadClient(cfg).request(
									`/node/pool/${encodeURIComponent(nodePool)}`,
									{ method: "POST", body: JSON.stringify({ Name: nodePool }) },
								);
							} catch (e) {
								emit.next(
									`⚠ Could not pre-create pool "${nodePool}" (${e instanceof Error ? e.message : "unknown"}); Nomad will auto-create it on join.\n`,
								);
							}
						}
						const script = getClusterWorkerJoinCommand({
							hubPublicKey: cluster.hubPublicKey,
							hubEndpoint: cluster.hubEndpoint,
							gossipKey: cluster.gossipKey,
							workerWgIp: wgIp,
							hubWgIp: cluster.hubWgIp,
							overlayCidr,
							servers: (cluster.servers || []).map((s) => ({
								wgIp: s.wgIp,
								publicKey: s.publicKey,
								endpoint: s.endpoint,
							})),
							aclTokens: readClusterAclTokens(),
							nodePool,
						});
						let pubkey = "";
						await execAsyncRemote(input.serverId, script, (log) => {
							emit.next(log);
							const cap = log.match(/WORKER_WG_PUBKEY=(\S+)/)?.[1];
							if (cap) pubkey = cap.trim();
						});
						if (!pubkey) {
							emit.next("\n❌ Did not receive the worker's WireGuard key\n");
							emit.next(OP_ENDED);
							emit.complete();
							return;
						}
						emit.next(
							`\nRegistering WireGuard peer on all servers (${wgIp})\n`,
						);
						await addPeerEverywhere(
							{ wgIp, publicKey: pubkey },
							serverMeshMembers(cluster),
							(l) => emit.next(l),
						);
						cluster.peers.push({
							wgIp,
							publicKey: pubkey,
							serverId: input.serverId,
							name: server.name,
						});
						writeCluster(cluster);
						await updateServerById(input.serverId, {
							nomadAddress: `http://${wgIp}:4646`,
							clusterRole: "worker",
							wgIp,
							wgPublicKey: pubkey,
							// Record which pool this node belongs to (default when unset) so the
							// UI + autoscaler can attribute it to the right group.
							nodePool: nodePool || "default",
						});
						emit.next("JOIN_DONE");
						emit.complete();
					} catch (err: unknown) {
						emitClusterError(emit, err, server);
					}
				})();
			});
		}),

	// Remove a node: drain it, leave Nomad/Consul (quorum-safe for servers),
	// remove its WireGuard peer from every remaining member, free its overlay IP.
	removeNode: withPermission("server", "delete")
		.input(z.object({ serverId: z.string(), force: z.boolean().optional() }))
		.subscription(async ({ input, ctx }) => {
			const server = await findServerById(input.serverId);
			if (server.organizationId !== ctx.session?.activeOrganizationId) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}

			return observable<string>((emit) => {
				(async () => {
					try {
						const cluster = readCluster();
						if (!cluster) {
							emit.next("❌ Cluster not initialized.\n");
							emit.next(OP_ENDED);
							emit.complete();
							return;
						}
						const worker = cluster.peers.find(
							(p) => p.serverId === input.serverId,
						);
						const srv = (cluster.servers || []).find(
							(s) => s.serverId === input.serverId,
						);
						const node = worker || srv;
						if (!node) {
							emit.next("❌ This server is not a cluster member.\n");
							emit.next(OP_ENDED);
							emit.complete();
							return;
						}

						if (srv) {
							const remaining = allServers(cluster).length - 1;
							if (remaining < 1) {
								emit.next("❌ Refusing: this is the last Nomad server.\n");
								emit.next(OP_ENDED);
								emit.complete();
								return;
							}
							if (remaining < 3 && !input.force) {
								emit.next(
									`⚠ Removing this server leaves ${remaining} server(s) — below the 3 needed for fault tolerance. Re-run with force to proceed.\n`,
								);
								emit.next(OP_ENDED);
								emit.complete();
								return;
							}
						}

						const cfg = {
							address: DEFAULT_ADDRESS,
							token: DEFAULT_TOKEN,
							namespace: "default",
						};
						let nomadNode: { ID: string; Name: string } | undefined;
						try {
							const nodes = (await nomadClient(cfg).get("/nodes")) as {
								ID: string;
								Name: string;
								Address: string;
							}[];
							nomadNode = nodes.find((n) => n.Address === node.wgIp);
						} catch {}

						if (nomadNode) {
							emit.next(`Draining node ${nomadNode.Name} …\n`);
							await execAsync(
								`nomad node drain -enable -yes -deadline 5m ${nomadNode.ID}`,
							).catch((e) =>
								emit.next(
									`⚠ drain: ${e instanceof Error ? e.message : String(e)}\n`,
								),
							);
						}

						if (srv) {
							emit.next(`Removing Nomad/Consul server ${srv.name} …\n`);
							const memberName = nomadNode?.Name ?? srv.name;
							await execAsync(`nomad server force-leave ${memberName}`).catch(
								() => {},
							);
							await execAsync(`consul force-leave ${srv.name}`).catch(() => {});
							await execAsync(
								`nomad operator raft remove-peer -peer-address=${srv.wgIp}:4647`,
							).catch(() => {});
							await execAsync(
								`consul operator raft remove-peer -address=${srv.wgIp}:8300`,
							).catch(() => {});
						}

						emit.next("Stopping services + WireGuard on the node …\n");
						// Also wipe the Nomad/Consul data dirs. Otherwise the node keeps its
						// old node ID + drain/eligibility state, so re-joining the same box
						// (as worker or server) re-attaches to the stale, ineligible
						// registration instead of coming back fresh.
						await execAsyncRemote(
							input.serverId,
							'SUDO=""; [ "$EUID" -ne 0 ] && SUDO=sudo; $SUDO systemctl stop nomad consul 2>/dev/null || true; $SUDO wg-quick down wg0 2>/dev/null || true; $SUDO systemctl disable wg-quick@wg0 2>/dev/null || true; $SUDO rm -rf /opt/nomad/client /opt/nomad/server /opt/nomad/data /opt/consul/* 2>/dev/null || true',
						).catch((e) =>
							emit.next(
								`⚠ node cleanup: ${e instanceof Error ? e.message : String(e)}\n`,
							),
						);
						await execAsync("nomad system gc").catch(() => {});
						if (worker) {
							await execAsync(`consul force-leave ${worker.name}`).catch(
								() => {},
							);
						}

						emit.next("Removing WireGuard peer from all members …\n");
						const members = (srv ? allMeshMembers : serverMeshMembers)(
							cluster,
						).filter((m) => m.serverId !== input.serverId);
						await removePeerEverywhere(node.publicKey, members, (l) =>
							emit.next(l),
						);

						cluster.peers = cluster.peers.filter(
							(p) => p.serverId !== input.serverId,
						);
						cluster.servers = (cluster.servers || []).filter(
							(s) => s.serverId !== input.serverId,
						);
						writeCluster(cluster);
						// A provider-backed node's row is deleted below, so skip the
						// field-clearing update for it (it would be immediately deleted).
						if (!server.providerNodeId) {
							await updateServerById(input.serverId, {
								nomadAddress: null,
								clusterRole: null,
								wgIp: null,
								wgPublicKey: null,
							});
						}

						// If this node runs on a cloud VM we provisioned, destroy it so
						// removal doesn't leak an idle (billed) machine.
						if (server.providerNodeId) {
							try {
								const cfg = await db.query.clusterAutoscaler.findFirst({
									where: eq(
										clusterAutoscaler.organizationId,
										server.organizationId,
									),
									with: { cloudProvider: true },
								});
								// Credential comes from the linked cloud account (Settings →
								// Cloud), falling back to the group's legacy token.
								const provider = cfg?.cloudProvider?.provider ?? cfg?.provider;
								const token = cfg?.cloudProvider?.token || cfg?.token;
								if (token && provider) {
									emit.next(
										`Destroying cloud VM (${provider} ${server.providerNodeId}) …\n`,
									);
									await getProvisioner({
										provider,
										token,
										serverTypes: [],
										location: cfg?.location ?? "",
										image: cfg?.image ?? "",
										networkId: cfg?.networkId || undefined,
									})
										.destroyNode(server.providerNodeId)
										.catch((e) =>
											emit.next(
												`⚠ VM destroy: ${e instanceof Error ? e.message : String(e)}\n`,
											),
										);
								} else {
									emit.next(
										"⚠ Node had a cloud VM but no provider token is configured — the VM was NOT destroyed. Remove it in your cloud console.\n",
									);
								}
							} catch {}
							await db
								.delete(serverTable)
								.where(eq(serverTable.serverId, input.serverId));
						}
						emit.next("REMOVE_DONE");
						emit.complete();
					} catch (err: unknown) {
						emitClusterError(emit, err, server);
					}
				})();
			});
		}),

	// One-click "Add node": provision a fresh cloud VM (using the same provider
	// config as the autoscaler) and auto-join it as a worker or server. Streams
	// progress; rolls back the VM on failure.
	provisionAndJoin: withPermission("server", "create")
		.input(
			z.object({
				role: z.enum(["server", "worker"]).default("worker"),
				// Which autoscaling group (node pool) to add the worker into.
				groupId: z.string().optional(),
			}),
		)
		.subscription(({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			return observable<string>((emit) => {
				(async () => {
					try {
						if (!org) {
							emit.next("❌ No active organization.\n");
							emit.next(OP_ENDED);
							emit.complete();
							return;
						}
						await provisionAndJoinNode(
							org,
							input.role,
							(l) => emit.next(l),
							input.groupId,
						);
						emit.complete();
					} catch (err: unknown) {
						emit.next(
							`\n❌ ${err instanceof Error ? err.message : String(err)}\n`,
						);
						emit.next(OP_ENDED);
						emit.complete();
					}
				})();
			});
		}),

	// Cluster-wide scheduler placement algorithm: "binpack" (default — pack allocs
	// onto fewest nodes, best for autoscaling scale-down) or "spread" (distribute
	// across nodes for resilience).
	getSchedulerConfig: withPermission("server", "read")
		.input(serverInput)
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const data: any = await nomadClient(cfg).get(
				"/operator/scheduler/configuration",
			);
			const sc = data.SchedulerConfig ?? {};
			return {
				algorithm: (sc.SchedulerAlgorithm as string) ?? "binpack",
				memoryOversubscription: !!sc.MemoryOversubscriptionEnabled,
			};
		}),

	setSchedulerAlgorithm: withPermission("server", "create")
		.input(serverInput.extend({ algorithm: z.enum(["binpack", "spread"]) }))
		.mutation(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			const client = nomadClient(cfg);
			// Read-modify-write so we preserve the other scheduler settings — most
			// importantly MemoryOversubscriptionEnabled, which the panel relies on.
			const cur: any = await client.get("/operator/scheduler/configuration");
			const sc = {
				...(cur.SchedulerConfig ?? {}),
				SchedulerAlgorithm: input.algorithm,
			};
			const res = await client.request("/operator/scheduler/configuration", {
				method: "POST",
				body: JSON.stringify(sc),
			});
			if (!res.ok)
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Nomad rejected the scheduler config: ${res.status}`,
				});
			return { success: true, algorithm: input.algorithm };
		}),

	// List cluster members (hub + servers + workers) with live Nomad status.
	getClusterMembers: withPermission("server", "read").query(async ({ ctx }) => {
		const cluster = readCluster();
		if (!cluster) return [];
		const cfg = {
			address: DEFAULT_ADDRESS,
			token: DEFAULT_TOKEN,
			namespace: "default",
		};
		let nodes: {
			Address: string;
			Status: string;
			SchedulingEligibility?: string;
			Drain?: boolean;
		}[] = [];
		try {
			nodes = (await nomadClient(cfg).get("/nodes")) as typeof nodes;
		} catch {}
		const nodeByIp = new Map(nodes.map((n) => [n.Address, n]));
		// Which server IP currently holds the Nomad raft leadership (host:port).
		let leaderIp = "";
		try {
			const leader = (await nomadClient(cfg).get("/status/leader")) as string;
			leaderIp = (leader || "").split(":")[0] ?? "";
		} catch {}
		const statusByIp = new Map(nodes.map((n) => [n.Address, n.Status]));
		// Node provenance: is it a cloud VM we can destroy on removal, and was it
		// spun up by the autoscaler vs. added manually / pre-existing?
		const org = ctx.session?.activeOrganizationId;
		const rows = org
			? await db.query.server.findMany({
					where: eq(serverTable.organizationId, org),
					columns: { serverId: true, autoscaled: true, providerNodeId: true },
				})
			: [];
		const provByServer = new Map(rows.map((r) => [r.serverId, r]));
		const row = (
			name: string,
			role: "server" | "worker",
			wgIp: string,
			serverId: string | null,
			// The node's WireGuard endpoint from cluster.json ("<privateIp>:51820");
			// its host part is the node's provider-private IP (Hetzner 10.14.x).
			endpoint?: string,
		) => {
			const prov = serverId ? provByServer.get(serverId) : undefined;
			const source: "control-plane" | "autoscaled" | "provisioned" | "manual" =
				serverId === null
					? "control-plane"
					: prov?.autoscaled
						? "autoscaled"
						: prov?.providerNodeId
							? "provisioned"
							: "manual";
			const node = nodeByIp.get(wgIp);
			return {
				name,
				role,
				wgIp,
				// Provider-private IP (host part of the WG endpoint); null if unknown.
				privateIp: endpoint ? (endpoint.split(":")[0] ?? null) : null,
				serverId,
				status: statusByIp.get(wgIp) ?? "unknown",
				leader: role === "server" && wgIp === leaderIp,
				source,
				// True when the node has a cloud VM behind it (removal can destroy it).
				hasVm: !!prov?.providerNodeId,
				// Maintenance state: draining = actively migrating allocs off;
				// ineligible = cordoned (no new allocs). Undefined when the Nomad node
				// isn't found (not yet joined).
				draining: node ? !!node.Drain : false,
				eligible: node ? node.SchedulingEligibility !== "ineligible" : true,
			};
		};
		return [
			row(
				"control-plane",
				"server",
				cluster.hubWgIp,
				null,
				cluster.hubEndpoint,
			),
			...(cluster.servers || []).map((s) =>
				row(s.name, "server", s.wgIp, s.serverId, s.endpoint),
			),
			// Worker peers are learned passively (no endpoint recorded) → no private IP.
			...cluster.peers.map((p) => row(p.name, "worker", p.wgIp, p.serverId)),
		];
	}),

	// Maintenance mode: drain (cordon + migrate allocs off) or un-drain a node
	// WITHOUT removing it from the cluster. Enable → node becomes ineligible and
	// its allocations reschedule elsewhere; disable → node is eligible again.
	// The control plane (hub) has serverId=null and is never a target (it runs the
	// panel + DB), so it can't be drained through here.
	setNodeDrain: withPermission("server", "create")
		.input(z.object({ serverId: z.string(), enable: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			const server = await findServerById(input.serverId);
			if (server.organizationId !== ctx.session?.activeOrganizationId) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}
			const cluster = readCluster();
			if (!cluster) throw new TRPCError({ code: "NOT_FOUND" });
			const member =
				cluster.peers.find((p) => p.serverId === input.serverId) ||
				(cluster.servers || []).find((s) => s.serverId === input.serverId);
			if (!member)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "This server is not a cluster member.",
				});

			const cfg = {
				address: DEFAULT_ADDRESS,
				token: DEFAULT_TOKEN,
				namespace: "default",
			};
			const nodes = (await nomadClient(cfg).get("/nodes")) as {
				ID: string;
				Address: string;
			}[];
			const node = nodes.find((n) => n.Address === member.wgIp);
			if (!node)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "No matching Nomad node (is it joined + ready?).",
				});

			// -detach returns as soon as the drain starts (the UI polls status); the
			// deadline bounds how long Nomad waits before force-evicting allocs.
			const cmd = input.enable
				? `nomad node drain -enable -yes -detach -deadline 5m ${node.ID}`
				: `nomad node drain -disable -yes ${node.ID}`;
			await execAsync(cmd);
			return { success: true };
		}),

	// Per-server cluster-DNS health: probe each server's overlay :53 resolver
	// (hub + HA servers run dnsmasq → local Consul). Surfaces whether HA DNS
	// failover is actually in place — e.g. a server joined before the HA-DNS
	// change that still needs its dnsmasq backfill shows up as down here.
	getClusterDnsHealth: withPermission("server", "read").query(async () => {
		const cluster = readCluster();
		if (!cluster) return [];
		const { Resolver } = await import("node:dns/promises");
		const probe = async (ip: string): Promise<boolean> => {
			try {
				const r = new Resolver({ timeout: 2000, tries: 1 });
				r.setServers([ip]);
				const res = await r.resolve4("consul.service.consul");
				return res.length > 0;
			} catch {
				return false;
			}
		};
		return Promise.all(
			allServers(cluster).map(async (s) => ({
				name: s.name,
				wgIp: s.wgIp,
				ok: await probe(s.wgIp),
			})),
		);
	}),

	// ── Phase B: network segmentation (Consul Connect) ──────────────────────
	// Toggle a project's mesh isolation, then reconcile intentions. Services
	// pick up the sidecar/mesh on their next deploy.
	setProjectIsolation: protectedProcedure
		.input(z.object({ projectId: z.string(), isolated: z.boolean() }))
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			const project = await db.query.projects.findFirst({
				where: and(
					eq(projects.projectId, input.projectId),
					eq(projects.organizationId, org),
				),
				columns: { projectId: true },
			});
			if (!project) throw new TRPCError({ code: "NOT_FOUND" });
			await db
				.update(projects)
				.set({ isolated: input.isolated })
				.where(eq(projects.projectId, input.projectId));
			await syncIntentionsForOrg(org).catch(() => ({ applied: 0, pruned: 0 }));
			return { success: true };
		}),

	getNetworkPolicies: protectedProcedure.query(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		return db.query.networkPolicies.findMany({
			where: eq(networkPolicies.organizationId, org),
			with: {
				sourceProject: { columns: { projectId: true, name: true } },
				targetProject: { columns: { projectId: true, name: true } },
			},
		});
	}),

	createNetworkPolicy: protectedProcedure
		.input(
			z.object({ sourceProjectId: z.string(), targetProjectId: z.string() }),
		)
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			if (input.sourceProjectId === input.targetProjectId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "A project can always reach itself.",
				});
			}
			// Both projects must belong to the caller's org.
			const owned = await db.query.projects.findMany({
				where: eq(projects.organizationId, org),
				columns: { projectId: true },
			});
			const ids = new Set(owned.map((p) => p.projectId));
			if (!ids.has(input.sourceProjectId) || !ids.has(input.targetProjectId)) {
				throw new TRPCError({ code: "NOT_FOUND" });
			}
			await db
				.insert(networkPolicies)
				.values({
					organizationId: org,
					sourceProjectId: input.sourceProjectId,
					targetProjectId: input.targetProjectId,
				})
				.onConflictDoNothing();
			await syncIntentionsForOrg(org).catch(() => ({ applied: 0, pruned: 0 }));
			return { success: true };
		}),

	removeNetworkPolicy: protectedProcedure
		.input(z.object({ networkPolicyId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			await db
				.delete(networkPolicies)
				.where(
					and(
						eq(networkPolicies.networkPolicyId, input.networkPolicyId),
						eq(networkPolicies.organizationId, org),
					),
				);
			await syncIntentionsForOrg(org).catch(() => ({ applied: 0, pruned: 0 }));
			return { success: true };
		}),

	// Force a reconcile (e.g. after deploys) — returns how many entries changed.
	applyNetworkPolicies: protectedProcedure.mutation(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		return syncIntentionsForOrg(org);
	}),

	// Everything the Network Policies UI needs: projects (+ isolation), the mesh
	// services live in the cluster grouped by project, and the allow-rules.
	getNetworkTopology: protectedProcedure.query(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		const orgProjects = await db.query.projects.findMany({
			where: eq(projects.organizationId, org),
			columns: { projectId: true, name: true, isolated: true },
		});
		const policies = await db.query.networkPolicies.findMany({
			where: eq(networkPolicies.organizationId, org),
			columns: {
				networkPolicyId: true,
				sourceProjectId: true,
				targetProjectId: true,
			},
		});
		let meshByProject: Record<string, string[]> = {};
		try {
			const catalog = (await consulGet(
				DEFAULT_CONSUL,
				"/catalog/services",
			)) as Record<string, string[]>;
			for (const s of meshServicesFromCatalog(catalog)) {
				meshByProject[s.projectId] = [
					...(meshByProject[s.projectId] ?? []),
					s.name,
				];
			}
		} catch {
			meshByProject = {};
		}
		return { projects: orgProjects, policies, meshByProject };
	}),

	// ── Phase C: cluster autoscaling ────────────────────────────────────────
	// Config for the org (token never returned — only whether one is set).
	// ── Autoscaling groups (Nomad node pools) ─────────────────────────────────
	// Each group is its own worker pool with its own launch template + scaling
	// policy. The built-in "default" pool is the default group (migrated from the
	// old single config). Tokens are masked on read.
	listAutoscalingGroups: protectedProcedure.query(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		const groups = await db.query.clusterAutoscaler.findMany({
			where: eq(clusterAutoscaler.organizationId, org),
			orderBy: [desc(clusterAutoscaler.isDefault), asc(clusterAutoscaler.name)],
		});
		// Expose the PK as `groupId` (the public group identifier the UI + the
		// other group endpoints use); never leak the provider token.
		return groups.map(({ token, autoscalerId, ...rest }) => ({
			...rest,
			groupId: autoscalerId,
			hasToken: !!token,
		}));
	}),

	// Create (no groupId) or update (groupId) a group. Ensures the Nomad node pool
	// exists so jobs can target it and nodes can join it.
	// Manually set a group's desired node count. Clamped to [min,max]; the reconcile
	// loop then converges the actual worker count to it (adding/removing auto nodes;
	// manual nodes stay pinned). Kicks a reconcile so it takes effect promptly.
	setDesiredCount: protectedProcedure
		.input(apiSetDesiredCount)
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			const group = await db.query.clusterAutoscaler.findFirst({
				where: and(
					eq(clusterAutoscaler.autoscalerId, input.groupId),
					eq(clusterAutoscaler.organizationId, org),
				),
				columns: { minNodes: true, maxNodes: true },
			});
			if (!group) throw new TRPCError({ code: "NOT_FOUND" });
			const desired = Math.max(
				group.minNodes,
				Math.min(group.maxNodes, input.desiredNodes),
			);
			await db
				.update(clusterAutoscaler)
				.set({ desiredNodes: desired })
				.where(eq(clusterAutoscaler.autoscalerId, input.groupId));
			void reconcileAutoscaler(org, (l) =>
				console.log(`[autoscaler:${org}] ${l.trimEnd()}`),
			).catch((e) => console.error(`[autoscaler:${org}]`, e));
			return { desired };
		}),

	// ── Scheduled scaling (per group) ──────────────────────────────────────────
	listAutoscalingSchedules: protectedProcedure
		.input(z.object({ groupId: z.string() }))
		.query(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			return db.query.autoscalingSchedule.findMany({
				where: and(
					eq(autoscalingSchedule.autoscalerId, input.groupId),
					eq(autoscalingSchedule.organizationId, org),
				),
				orderBy: [asc(autoscalingSchedule.name)],
			});
		}),

	upsertAutoscalingSchedule: protectedProcedure
		.input(apiUpsertAutoscalingSchedule)
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			// The group must belong to the caller's org.
			const group = await db.query.clusterAutoscaler.findFirst({
				where: and(
					eq(clusterAutoscaler.autoscalerId, input.autoscalerId),
					eq(clusterAutoscaler.organizationId, org),
				),
				columns: { autoscalerId: true },
			});
			if (!group) throw new TRPCError({ code: "NOT_FOUND" });
			const { scheduleId, ...rest } = input;
			let id = scheduleId;
			if (scheduleId) {
				const existing = await db.query.autoscalingSchedule.findFirst({
					where: and(
						eq(autoscalingSchedule.scheduleId, scheduleId),
						eq(autoscalingSchedule.organizationId, org),
					),
					columns: { scheduleId: true },
				});
				if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
				await db
					.update(autoscalingSchedule)
					.set({ ...rest })
					.where(eq(autoscalingSchedule.scheduleId, scheduleId));
			} else {
				const [row] = await db
					.insert(autoscalingSchedule)
					.values({ ...rest, organizationId: org })
					.returning({ scheduleId: autoscalingSchedule.scheduleId });
				id = row?.scheduleId;
			}
			if (id) await rescheduleAutoscalingAction(id);
			return { scheduleId: id };
		}),

	deleteAutoscalingSchedule: protectedProcedure
		.input(z.object({ scheduleId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			await db
				.delete(autoscalingSchedule)
				.where(
					and(
						eq(autoscalingSchedule.scheduleId, input.scheduleId),
						eq(autoscalingSchedule.organizationId, org),
					),
				);
			removeAutoscalingScheduleJob(input.scheduleId);
			return { success: true };
		}),

	upsertAutoscalingGroup: protectedProcedure
		.input(apiUpsertAutoscalingGroup)
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			const { groupId, token, poolName, name, ...rest } = input;
			const setToken = token && token.length > 0 ? { token } : {};

			// poolName is the Nomad node pool — unique within the org.
			if (poolName) {
				const clash = await db.query.clusterAutoscaler.findFirst({
					where: and(
						eq(clusterAutoscaler.organizationId, org),
						eq(clusterAutoscaler.poolName, poolName),
						groupId ? ne(clusterAutoscaler.autoscalerId, groupId) : undefined,
					),
					columns: { autoscalerId: true },
				});
				if (clash)
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: `Node pool "${poolName}" is already used by another group.`,
					});
			}

			let effectivePool = poolName;
			if (groupId) {
				const existing = await db.query.clusterAutoscaler.findFirst({
					where: and(
						eq(clusterAutoscaler.autoscalerId, groupId),
						eq(clusterAutoscaler.organizationId, org),
					),
				});
				if (!existing)
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Group not found",
					});
				// The default group's pool name is fixed to "default".
				const poolUpdate = poolName && !existing.isDefault ? { poolName } : {};
				await db
					.update(clusterAutoscaler)
					.set({
						...rest,
						...(name ? { name } : {}),
						...poolUpdate,
						...setToken,
					})
					.where(eq(clusterAutoscaler.autoscalerId, groupId));
				effectivePool = existing.isDefault
					? "default"
					: (poolName ?? existing.poolName);
			} else {
				if (!name || !poolName)
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "A new group needs a name and a pool name.",
					});
				await db.insert(clusterAutoscaler).values({
					organizationId: org,
					name,
					poolName,
					...rest,
					...setToken,
				});
				effectivePool = poolName;
			}

			// Create the Nomad node pool (Nomad also auto-creates it when a node joins,
			// but do it eagerly so it appears + jobs can target it immediately).
			if (effectivePool && effectivePool !== "default") {
				try {
					const cfg = await resolveNomad(ctx, undefined);
					await nomadClient(cfg).request(
						`/node/pool/${encodeURIComponent(effectivePool)}`,
						{ method: "POST", body: JSON.stringify({ Name: effectivePool }) },
					);
				} catch {}
			}
			return { success: true };
		}),

	deleteAutoscalingGroup: protectedProcedure
		.input(z.object({ groupId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			const group = await db.query.clusterAutoscaler.findFirst({
				where: and(
					eq(clusterAutoscaler.autoscalerId, input.groupId),
					eq(clusterAutoscaler.organizationId, org),
				),
			});
			if (!group)
				throw new TRPCError({ code: "NOT_FOUND", message: "Group not found" });
			if (group.isDefault)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The default group can't be deleted.",
				});
			// Refuse while the pool still has nodes — scale/remove them first.
			const nodes = await db.query.server.findMany({
				where: and(
					eq(serverTable.organizationId, org),
					eq(serverTable.nodePool, group.poolName),
				),
				columns: { serverId: true },
			});
			if (nodes.length > 0)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Pool "${group.poolName}" still has ${nodes.length} node(s). Remove them first.`,
				});
			await db
				.delete(clusterAutoscaler)
				.where(eq(clusterAutoscaler.autoscalerId, input.groupId));
			if (group.poolName !== "default") {
				try {
					const cfg = await resolveNomad(ctx, undefined);
					await nomadClient(cfg).request(
						`/node/pool/${encodeURIComponent(group.poolName)}`,
						{ method: "DELETE" },
					);
				} catch {}
			}
			return { success: true };
		}),

	// Per-group cluster pressure + the nodes in each group's pool (for the UI).
	getAutoscalerStatus: protectedProcedure.query(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		const groups = await db.query.clusterAutoscaler.findMany({
			where: eq(clusterAutoscaler.organizationId, org),
			orderBy: [desc(clusterAutoscaler.isDefault), asc(clusterAutoscaler.name)],
		});
		return Promise.all(
			groups.map(async (g) => {
				let decision: Awaited<ReturnType<typeof evaluateCluster>> | null = null;
				try {
					decision = await evaluateCluster(g);
				} catch {}
				const nodes = await db.query.server.findMany({
					where: and(
						eq(serverTable.organizationId, org),
						eq(serverTable.nodePool, g.poolName),
					),
					columns: {
						serverId: true,
						name: true,
						ipAddress: true,
						wgIp: true,
						clusterRole: true,
						autoscaled: true,
					},
				});
				return {
					groupId: g.autoscalerId,
					name: g.name,
					poolName: g.poolName,
					isDefault: g.isDefault,
					enabled: g.enabled,
					decision,
					nodes,
				};
			}),
		);
	}),

	// Manual reconcile trigger (all groups). Runs in the background (a scale-up can
	// take minutes); returns immediately.
	reconcileAutoscalerNow: protectedProcedure.mutation(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		void reconcileAutoscaler(org, (l) =>
			console.log(`[autoscaler:${org}] ${l.trimEnd()}`),
		).catch((e) => console.error(`[autoscaler:${org}]`, e));
		return { started: true };
	}),

	// Autoscaler activity feed (most recent first), optionally scoped to a group.
	getAutoscalerEvents: protectedProcedure
		.input(
			z
				.object({
					groupId: z.string().optional(),
					limit: z.number().int().min(1).max(100).optional(),
					offset: z.number().int().min(0).optional(),
				})
				.optional(),
		)
		.query(async ({ ctx, input }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			const limit = input?.limit ?? 10;
			const offset = input?.offset ?? 0;
			const where = and(
				eq(clusterAutoscalerEvents.organizationId, org),
				input?.groupId
					? eq(clusterAutoscalerEvents.groupId, input.groupId)
					: undefined,
			);
			// Fetch one extra row to tell the client whether another page exists,
			// without a second COUNT query.
			const rows = await db.query.clusterAutoscalerEvents.findMany({
				where,
				orderBy: [desc(clusterAutoscalerEvents.createdAt)],
				limit: limit + 1,
				offset,
			});
			return { events: rows.slice(0, limit), hasMore: rows.length > limit };
		}),

	// List the cloud's locations / private networks / server types for the config
	// dropdowns. Uses the token being entered (input.token) or a saved group token.
	listProviderOptions: protectedProcedure
		.input(
			z
				.object({
					groupId: z.string().optional(),
					cloudProviderId: z.string().optional(),
					token: z.string().optional(),
					provider: z.string().optional(),
					location: z.string().optional(),
					image: z.string().optional(),
				})
				.optional(),
		)
		.mutation(async ({ ctx, input }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			let token = input?.token;
			let provider = input?.provider || "hetzner";
			let location = input?.location || "nbg1";
			let image = input?.image || "ubuntu-24.04";
			// Prefer a selected cloud account’s saved token (Settings → Cloud).
			if (!token && input?.cloudProviderId) {
				const cp = await db.query.cloudProvider.findFirst({
					where: and(
						eq(cloudProvider.cloudProviderId, input.cloudProviderId),
						eq(cloudProvider.organizationId, org),
					),
				});
				if (cp?.token) {
					token = cp.token;
					provider = cp.provider;
				}
			}
			if (!token) {
				const g = input?.groupId
					? await db.query.clusterAutoscaler.findFirst({
							where: and(
								eq(clusterAutoscaler.autoscalerId, input.groupId),
								eq(clusterAutoscaler.organizationId, org),
							),
							with: { cloudProvider: true },
						})
					: await db.query.clusterAutoscaler.findFirst({
							where: eq(clusterAutoscaler.organizationId, org),
							with: { cloudProvider: true },
						});
				const gToken = g?.cloudProvider?.token || g?.token;
				if (gToken) {
					token = gToken;
					provider = g?.cloudProvider?.provider ?? g?.provider ?? provider;
					location = g?.location ?? location;
					image = g?.image ?? image;
				}
			}
			if (!token)
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Save or enter a provider API token first.",
				});
			try {
				const provisioner = getProvisioner({
					provider,
					token,
					serverTypes: [],
					location,
					image,
				});
				return await provisioner.listOptions();
			} catch (e) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: e instanceof Error ? e.message : "Failed to list options",
				});
			}
		}),
});
