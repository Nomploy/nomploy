import { findServerById, updateServerById } from "@nomploy/server";
import { db } from "@nomploy/server/db";
import {
	apiUpsertAutoscalingGroup,
	clusterAutoscaler,
	clusterAutoscalerEvents,
	networkPolicies,
	projects,
	server as serverTable,
} from "@nomploy/server/db/schema";
import {
	findApplicationById,
	updateApplication,
} from "@nomploy/server/services/application";
import { checkServicePermissionAndAccess } from "@nomploy/server/services/permission";
import { getProvisioner } from "@nomploy/server/setup/autoscale";
import {
	evaluateCluster,
	provisionAndJoinNode,
	reconcileAutoscaler,
} from "@nomploy/server/setup/autoscale/reconcile";
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
						Name: node.Name as string,
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
						Name: node.Name as string,
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
			return {
				items: v.Items ?? {},
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

			if (keys.length === 0) {
				const del = await client.request(withNs(path, cfg.namespace), {
					method: "DELETE",
				});
				if (!del.ok && del.status !== 404) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: `Nomad variable delete failed: ${del.status} ${del.statusText}`,
					});
				}
				await updateApplication(input.applicationId, {
					nomadSecretsEnabled: false,
				});
			} else {
				const put = await client.request(withNs(path, cfg.namespace), {
					method: "PUT",
					body: JSON.stringify({
						Path: `nomad/jobs/${application.appName}`,
						Items: input.items,
					}),
				});
				if (!put.ok) {
					const detail = await put.text().catch(() => "");
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: `Nomad variable write failed: ${put.status} ${detail}`,
					});
				}
				await updateApplication(input.applicationId, {
					nomadSecretsEnabled: true,
				});
			}

			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return { enabled: keys.length > 0, count: keys.length };
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
			}),
		)
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
								});
								if (cfg?.token) {
									emit.next(
										`Destroying cloud VM (${cfg.provider} ${server.providerNodeId}) …\n`,
									);
									await getProvisioner({
										provider: cfg.provider,
										token: cfg.token,
										serverTypes: [],
										location: cfg.location,
										image: cfg.image,
										networkId: cfg.networkId || undefined,
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
			row("control-plane", "server", cluster.hubWgIp, null),
			...(cluster.servers || []).map((s) =>
				row(s.name, "server", s.wgIp, s.serverId),
			),
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
		.input(z.object({ groupId: z.string().optional() }).optional())
		.query(async ({ ctx, input }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			return db.query.clusterAutoscalerEvents.findMany({
				where: and(
					eq(clusterAutoscalerEvents.organizationId, org),
					input?.groupId
						? eq(clusterAutoscalerEvents.groupId, input.groupId)
						: undefined,
				),
				orderBy: [desc(clusterAutoscalerEvents.createdAt)],
				limit: 50,
			});
		}),

	// List the cloud's locations / private networks / server types for the config
	// dropdowns. Uses the token being entered (input.token) or a saved group token.
	listProviderOptions: protectedProcedure
		.input(
			z
				.object({
					groupId: z.string().optional(),
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
			if (!token) {
				const g = input?.groupId
					? await db.query.clusterAutoscaler.findFirst({
							where: and(
								eq(clusterAutoscaler.autoscalerId, input.groupId),
								eq(clusterAutoscaler.organizationId, org),
							),
						})
					: await db.query.clusterAutoscaler.findFirst({
							where: eq(clusterAutoscaler.organizationId, org),
						});
				if (g?.token) {
					token = g.token;
					provider = g.provider;
					location = g.location;
					image = g.image;
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
