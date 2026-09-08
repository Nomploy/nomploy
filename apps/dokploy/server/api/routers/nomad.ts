import { findServerById, updateServerById } from "@nomploy/server";
import { db } from "@nomploy/server/db";
import {
	apiUpdateClusterAutoscaler,
	apiUpsertZotRegistry,
	clusterAutoscaler,
	clusterAutoscalerEvents,
	networkPolicies,
	projects,
	server as serverTable,
	zotRegistry,
} from "@nomploy/server/db/schema";
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
	removePeerEverywhere,
	serverMeshMembers,
	writeCluster,
} from "@nomploy/server/setup/nomad-mesh";
import {
	disableZotRegistry,
	enableZotRegistry,
} from "@nomploy/server/setup/zot-setup";
import {
	execAsync,
	execAsyncRemote,
} from "@nomploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
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
			return nomadClient(cfg).get(withNs(`/job/${input.jobId}`, cfg.namespace));
		}),

	getJobAllocations: withPermission("server", "read")
		.input(serverInput.extend({ jobId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			return nomadClient(cfg).get(
				withNs(`/job/${input.jobId}/allocations`, cfg.namespace),
			);
		}),

	getJobScale: withPermission("server", "read")
		.input(serverInput.extend({ jobId: z.string() }))
		.query(async ({ input, ctx }) => {
			const cfg = await resolveNomad(ctx, input.serverId);
			return nomadClient(cfg).get(
				withNs(`/job/${input.jobId}/scale`, cfg.namespace),
			);
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
		.input(z.object({ role: z.enum(["server", "worker"]).default("worker") }))
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
						await provisionAndJoinNode(org, input.role, (l) => emit.next(l));
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
	getAutoscalerConfig: protectedProcedure.query(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		const cfg = await db.query.clusterAutoscaler.findFirst({
			where: eq(clusterAutoscaler.organizationId, org),
		});
		if (!cfg) return null;
		const { token, ...rest } = cfg;
		return { ...rest, hasToken: !!token };
	}),

	updateAutoscalerConfig: protectedProcedure
		.input(apiUpdateClusterAutoscaler)
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			// Only overwrite the token when a non-empty one is provided.
			const { token, ...rest } = input;
			const setToken = token && token.length > 0 ? { token } : {};
			const existing = await db.query.clusterAutoscaler.findFirst({
				where: eq(clusterAutoscaler.organizationId, org),
				columns: { autoscalerId: true },
			});
			if (existing) {
				await db
					.update(clusterAutoscaler)
					.set({ ...rest, ...setToken })
					.where(eq(clusterAutoscaler.organizationId, org));
			} else {
				await db
					.insert(clusterAutoscaler)
					.values({ organizationId: org, ...rest, ...setToken });
			}
			return { success: true };
		}),

	// Current cluster pressure + the autoscaled nodes we manage (for the UI).
	getAutoscalerStatus: protectedProcedure.query(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		const cfg = await db.query.clusterAutoscaler.findFirst({
			where: eq(clusterAutoscaler.organizationId, org),
		});
		const nodes = await db.query.server.findMany({
			where: and(
				eq(serverTable.organizationId, org),
				eq(serverTable.autoscaled, true),
			),
			columns: {
				serverId: true,
				name: true,
				ipAddress: true,
				wgIp: true,
				clusterRole: true,
			},
		});
		let decision: Awaited<ReturnType<typeof evaluateCluster>> | null = null;
		if (cfg) {
			try {
				decision = await evaluateCluster(cfg);
			} catch {}
		}
		return { enabled: !!cfg?.enabled, decision, nodes };
	}),

	// Manual reconcile trigger. Runs in the background (a scale-up can take
	// minutes); returns the current decision immediately.
	reconcileAutoscalerNow: protectedProcedure.mutation(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		void reconcileAutoscaler(org, (l) =>
			console.log(`[autoscaler:${org}] ${l.trimEnd()}`),
		).catch((e) => console.error(`[autoscaler:${org}]`, e));
		return { started: true };
	}),

	// Autoscaler activity feed (most recent first) — like a cloud ASG's history.
	getAutoscalerEvents: protectedProcedure.query(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		return db.query.clusterAutoscalerEvents.findMany({
			where: eq(clusterAutoscalerEvents.organizationId, org),
			orderBy: [desc(clusterAutoscalerEvents.createdAt)],
			limit: 50,
		});
	}),

	// List the cloud's locations / private networks / server types so the UI can
	// offer dropdowns instead of free-text. Uses the saved token.
	listProviderOptions: protectedProcedure.mutation(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		const cfg = await db.query.clusterAutoscaler.findFirst({
			where: eq(clusterAutoscaler.organizationId, org),
		});
		if (!cfg?.token)
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Save a provider API token first.",
			});
		try {
			const provisioner = getProvisioner({
				provider: cfg.provider,
				token: cfg.token,
				serverTypes: [],
				location: cfg.location,
				image: cfg.image,
			});
			return await provisioner.listOptions();
		} catch (e) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: e instanceof Error ? e.message : "Failed to list options",
			});
		}
	}),

	// ── Built-in registry (zot) ─────────────────────────────────────────────
	getZotRegistry: protectedProcedure.query(async ({ ctx }) => {
		const org = ctx.session?.activeOrganizationId;
		if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
		const cfg = await db.query.zotRegistry.findFirst({
			where: eq(zotRegistry.organizationId, org),
		});
		if (!cfg) return null;
		// Mask secrets; expose booleans so the UI can show "set".
		const { password, s3SecretAccessKey, ...rest } = cfg;
		const hubWgIp = readCluster()?.hubWgIp || "10.10.0.1";
		return {
			...rest,
			hasPassword: !!password,
			hasS3Secret: !!s3SecretAccessKey,
			// Overlay address the registry is (or will be) reachable at.
			address: `${hubWgIp}:${cfg.port}`,
		};
	}),

	updateZotRegistry: protectedProcedure
		.input(apiUpsertZotRegistry)
		.mutation(async ({ input, ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			// Only overwrite secrets when a non-empty value is provided.
			const patch: Record<string, unknown> = { ...input };
			if (!input.password) patch.password = undefined;
			if (!input.s3SecretAccessKey) patch.s3SecretAccessKey = undefined;
			const existing = await db.query.zotRegistry.findFirst({
				where: eq(zotRegistry.organizationId, org),
			});
			if (existing) {
				await db
					.update(zotRegistry)
					.set(patch)
					.where(eq(zotRegistry.organizationId, org));
			} else {
				await db.insert(zotRegistry).values({ ...patch, organizationId: org });
			}
			return { success: true };
		}),

	enableZotRegistry: withPermission("server", "create").subscription(
		({ ctx }) => {
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
						await enableZotRegistry(org, (l) => emit.next(l));
						emit.next("ZOT_DONE");
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
		},
	),

	disableZotRegistry: withPermission("server", "delete").mutation(
		async ({ ctx }) => {
			const org = ctx.session?.activeOrganizationId;
			if (!org) throw new TRPCError({ code: "UNAUTHORIZED" });
			await disableZotRegistry(org);
			return { success: true };
		},
	),
});
