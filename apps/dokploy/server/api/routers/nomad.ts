import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { findServerById, updateServerById } from "@nomploy/server";
import { getNomadBootstrapCommand } from "@nomploy/server/setup/nomad-bootstrap";
import { getClusterWorkerJoinCommand } from "@nomploy/server/setup/nomad-cluster";
import {
	execAsync,
	execAsyncRemote,
} from "@nomploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "../trpc";

// Cluster state written by the installer's hub setup and updated as nodes join.
const CLUSTER_FILE = "/etc/nomploy/cluster.json";
interface ClusterState {
	hubPublicKey: string;
	gossipKey: string;
	hubWgIp: string;
	hubEndpoint: string;
	overlayCidr?: string;
	peers: { wgIp: string; publicKey: string; serverId: string; name: string }[];
}

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

const serverInput = z.object({ serverId: z.string().optional() });

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
						emit.complete();
					});
			});
		}),

	// Join a server to the Nomad cluster over the WireGuard mesh: install +
	// configure it as a Consul/Nomad client, then register its WireGuard peer on
	// the hub (this control plane). Streams progress.
	joinCluster: withPermission("server", "create")
		.input(z.object({ serverId: z.string() }))
		.subscription(async ({ input, ctx }) => {
			const server = await findServerById(input.serverId);
			if (server.organizationId !== ctx.session?.activeOrganizationId) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}

			return observable<string>((emit) => {
				(async () => {
					try {
						if (!existsSync(CLUSTER_FILE)) {
							emit.next(
								"❌ Cluster not initialized on the control plane (missing /etc/nomploy/cluster.json).\n",
							);
							emit.complete();
							return;
						}
						const cluster: ClusterState = JSON.parse(
							readFileSync(CLUSTER_FILE, "utf8"),
						);
						cluster.peers = cluster.peers || [];

						// Allocate the next free overlay IP (hub keeps .1).
						const prefix = cluster.hubWgIp.replace(/\.\d+$/, "");
						const used = new Set([
							cluster.hubWgIp,
							...cluster.peers.map((p) => p.wgIp),
						]);
						let n = 2;
						while (used.has(`${prefix}.${n}`)) n++;
						const wgIp = `${prefix}.${n}`;
						emit.next(`Assigning overlay IP ${wgIp} to "${server.name}"\n`);

						const script = getClusterWorkerJoinCommand({
							hubPublicKey: cluster.hubPublicKey,
							hubEndpoint: cluster.hubEndpoint,
							gossipKey: cluster.gossipKey,
							workerWgIp: wgIp,
							hubWgIp: cluster.hubWgIp,
							overlayCidr: cluster.overlayCidr,
						});

						let pubkey = "";
						await execAsyncRemote(input.serverId, script, (log) => {
							emit.next(log);
							const cap = log.match(/WORKER_WG_PUBKEY=(\S+)/)?.[1];
							if (cap) pubkey = cap.trim();
						});
						if (!pubkey) {
							emit.next("\n❌ Did not receive the worker's WireGuard key\n");
							emit.complete();
							return;
						}

						emit.next(`\nRegistering WireGuard peer on the hub (${wgIp})\n`);
						await execAsync(
							`wg set wg0 peer ${pubkey} allowed-ips ${wgIp}/32 && wg-quick save wg0`,
						);

						cluster.peers.push({
							wgIp,
							publicKey: pubkey,
							serverId: input.serverId,
							name: server.name,
						});
						writeFileSync(CLUSTER_FILE, JSON.stringify(cluster, null, 2));
						await updateServerById(input.serverId, {
							nomadAddress: `http://${wgIp}:4646`,
						});

						emit.next("JOIN_DONE");
						emit.complete();
					} catch (err: unknown) {
						const message =
							err instanceof Error ? err.message : "Cluster join failed";
						emit.next(`\n❌ ${message}\n`);
						emit.complete();
					}
				})();
			});
		}),
});
