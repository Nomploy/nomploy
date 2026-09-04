import { findServerById, updateServerById } from "@nomploy/server";
import { getNomadBootstrapCommand } from "@nomploy/server/setup/nomad-bootstrap";
import {
	getClusterServerJoinCommand,
	getClusterWorkerJoinCommand,
} from "@nomploy/server/setup/nomad-cluster";
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
	execAsync,
	execAsyncRemote,
} from "@nomploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "../trpc";

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
						await updateServerById(input.serverId, {
							nomadAddress: null,
							clusterRole: null,
							wgIp: null,
							wgPublicKey: null,
						});
						emit.next("REMOVE_DONE");
						emit.complete();
					} catch (err: unknown) {
						emitClusterError(emit, err, server);
					}
				})();
			});
		}),

	// List cluster members (hub + servers + workers) with live Nomad status.
	getClusterMembers: withPermission("server", "read").query(async () => {
		const cluster = readCluster();
		if (!cluster) return [];
		const cfg = {
			address: DEFAULT_ADDRESS,
			token: DEFAULT_TOKEN,
			namespace: "default",
		};
		let nodes: { Address: string; Status: string }[] = [];
		try {
			nodes = (await nomadClient(cfg).get("/nodes")) as {
				Address: string;
				Status: string;
			}[];
		} catch {}
		// Which server IP currently holds the Nomad raft leadership (host:port).
		let leaderIp = "";
		try {
			const leader = (await nomadClient(cfg).get("/status/leader")) as string;
			leaderIp = (leader || "").split(":")[0] ?? "";
		} catch {}
		const statusByIp = new Map(nodes.map((n) => [n.Address, n.Status]));
		const row = (
			name: string,
			role: "server" | "worker",
			wgIp: string,
			serverId: string | null,
		) => ({
			name,
			role,
			wgIp,
			serverId,
			status: statusByIp.get(wgIp) ?? "unknown",
			leader: role === "server" && wgIp === leaderIp,
		});
		return [
			row("control-plane", "server", cluster.hubWgIp, null),
			...(cluster.servers || []).map((s) =>
				row(s.name, "server", s.wgIp, s.serverId),
			),
			...cluster.peers.map((p) => row(p.name, "worker", p.wgIp, p.serverId)),
		];
	}),
});
