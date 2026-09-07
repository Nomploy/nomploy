import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db";
import { clusterAutoscaler, server as serverTable } from "../../db/schema";
import { execAsyncRemote } from "../../utils/process/execAsync";
import { getProvisioner } from "./index";
import { joinWorkerNode, removeWorkerNode } from "./join";

type Log = (s: string) => void;

const NOMAD_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const NOMAD_TOKEN = process.env.NOMAD_TOKEN || "";

const nomad = async (path: string) => {
	const res = await fetch(`${NOMAD_ADDRESS.replace(/\/$/, "")}/v1${path}`, {
		headers: NOMAD_TOKEN ? { "X-Nomad-Token": NOMAD_TOKEN } : {},
	});
	if (!res.ok) throw new Error(`Nomad ${res.status} on ${path}`);
	return res.json();
};

interface Decision {
	action: "up" | "down" | "none";
	reason: string;
	utilization: number;
	blockedEvals: number;
	autoscaledCount: number;
}

/** Compute the current cluster pressure + what the autoscaler should do. */
export const evaluateCluster = async (cfg: {
	minNodes: number;
	maxNodes: number;
	scaleUpThreshold: number;
	scaleDownThreshold: number;
	organizationId: string;
}): Promise<Decision> => {
	// Client nodes that can currently receive work.
	const nodes = (await nomad("/nodes")) as {
		ID: string;
		Status: string;
		SchedulingEligibility: string;
	}[];
	const ready = nodes.filter(
		(n) => n.Status === "ready" && n.SchedulingEligibility === "eligible",
	);

	let cpuTotal = 0;
	let memTotal = 0;
	for (const n of ready) {
		try {
			const d = (await nomad(`/node/${n.ID}`)) as {
				NodeResources?: {
					Cpu?: { CpuShares?: number };
					Memory?: { MemoryMB?: number };
				};
			};
			cpuTotal += d.NodeResources?.Cpu?.CpuShares || 0;
			memTotal += d.NodeResources?.Memory?.MemoryMB || 0;
		} catch {}
	}

	const allocs = (await nomad("/allocations?resources=true")) as {
		ClientStatus: string;
		AllocatedResources?: {
			Tasks?: Record<
				string,
				{ Cpu?: { CpuShares?: number }; Memory?: { MemoryMB?: number } }
			>;
		};
	}[];
	let cpuUsed = 0;
	let memUsed = 0;
	for (const a of allocs) {
		if (a.ClientStatus !== "running") continue;
		for (const t of Object.values(a.AllocatedResources?.Tasks || {})) {
			cpuUsed += t?.Cpu?.CpuShares || 0;
			memUsed += t?.Memory?.MemoryMB || 0;
		}
	}
	const cpuPct = cpuTotal > 0 ? (cpuUsed / cpuTotal) * 100 : 0;
	const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
	const utilization = Math.round(Math.max(cpuPct, memPct));

	// Blocked evaluations = allocations that could not be placed (needs capacity).
	let blockedEvals = 0;
	try {
		const evals = (await nomad("/evaluations")) as { Status: string }[];
		blockedEvals = evals.filter((e) => e.Status === "blocked").length;
	} catch {}

	// Autoscaled worker nodes we currently manage.
	const autoscaled = await db.query.server.findMany({
		where: and(
			eq(serverTable.organizationId, cfg.organizationId),
			eq(serverTable.autoscaled, true),
		),
		columns: { serverId: true, clusterRole: true },
	});
	const autoscaledCount = autoscaled.filter(
		(s) => s.clusterRole === "worker",
	).length;

	const base = { utilization, blockedEvals, autoscaledCount };
	// Floor first: always keep at least minNodes autoscaled workers, even with no
	// pressure. (Also caps runaway scale-up from a permanently-unplaceable alloc,
	// since the pressure branch below still respects maxNodes.)
	if (autoscaledCount < cfg.minNodes) {
		return {
			action: "up",
			reason: `below min nodes (${autoscaledCount} < ${cfg.minNodes})`,
			...base,
		};
	}
	if (
		(blockedEvals > 0 || utilization >= cfg.scaleUpThreshold) &&
		autoscaledCount < cfg.maxNodes
	) {
		return {
			action: "up",
			reason:
				blockedEvals > 0
					? `${blockedEvals} blocked evaluation(s) — need capacity`
					: `utilization ${utilization}% ≥ ${cfg.scaleUpThreshold}%`,
			...base,
		};
	}
	if (
		utilization <= cfg.scaleDownThreshold &&
		autoscaledCount > cfg.minNodes &&
		blockedEvals === 0
	) {
		return {
			action: "down",
			reason: `utilization ${utilization}% ≤ ${cfg.scaleDownThreshold}%`,
			...base,
		};
	}
	return { action: "none", reason: "within thresholds", ...base };
};

/** Wait until the control plane can SSH into the new node (cloud-init + boot). */
const waitForSsh = async (serverId: string, onLog: Log) => {
	for (let i = 0; i < 40; i++) {
		try {
			await execAsyncRemote(serverId, "echo nomploy-ssh-ok");
			return true;
		} catch {
			await new Promise((r) => setTimeout(r, 5000));
		}
	}
	onLog("⚠ SSH did not become ready in time\n");
	return false;
};

/**
 * One reconcile tick for an org: evaluate pressure, then (respecting cooldown)
 * provision+join a worker or drain+remove+destroy an idle one. Idempotent and
 * safe to call on an interval. Returns a short status string.
 */
export const reconcileAutoscaler = async (
	organizationId: string,
	onLog: Log = () => {},
): Promise<string> => {
	const cfg = await db.query.clusterAutoscaler.findFirst({
		where: eq(clusterAutoscaler.organizationId, organizationId),
	});
	if (!cfg || !cfg.enabled) return "disabled";

	const decision = await evaluateCluster(cfg);
	onLog(
		`autoscaler: util=${decision.utilization}% blocked=${decision.blockedEvals} nodes=${decision.autoscaledCount} → ${decision.action} (${decision.reason})\n`,
	);
	if (decision.action === "none") return `none: ${decision.reason}`;

	// Cooldown guard.
	const now = Date.now();
	if (cfg.lastScaleAt) {
		const elapsed = (now - new Date(cfg.lastScaleAt).getTime()) / 1000;
		if (elapsed < cfg.cooldownSeconds) {
			return `cooldown: ${Math.round(cfg.cooldownSeconds - elapsed)}s left`;
		}
	}

	const stamp = () =>
		db
			.update(clusterAutoscaler)
			.set({ lastScaleAt: new Date().toISOString() })
			.where(eq(clusterAutoscaler.autoscalerId, cfg.autoscalerId));

	if (decision.action === "up") {
		if (!cfg.sshKeyId) throw new Error("Autoscaler has no SSH key configured");
		const key = await db.query.sshKeys.findFirst({
			where: (k, { eq: e }) => e(k.sshKeyId, cfg.sshKeyId as string),
			columns: { publicKey: true },
		});
		if (!key?.publicKey)
			throw new Error("Configured SSH key has no public key");

		const provisioner = getProvisioner({
			provider: cfg.provider,
			token: cfg.token,
			serverType: cfg.serverType,
			location: cfg.location,
			image: cfg.image,
			networkId: cfg.networkId || undefined,
		});
		const name = `nomploy-auto-${nanoid(6).toLowerCase()}`;
		onLog(`Provisioning ${cfg.provider} node ${name} …\n`);
		const node = await provisioner.createNode({
			name,
			sshPublicKey: key.publicKey,
		});
		const ip = node.privateIp || node.publicIp;
		onLog(`Node ${name} up at ${ip} (provider id ${node.providerId})\n`);

		// Register the node as a nomploy server, then join it as a worker.
		const [row] = await db
			.insert(serverTable)
			.values({
				serverId: nanoid(),
				name,
				ipAddress: ip,
				port: 22,
				username: "root",
				sshKeyId: cfg.sshKeyId,
				organizationId,
				createdAt: new Date().toISOString(),
				autoscaled: true,
				providerNodeId: node.providerId,
			})
			.returning();
		if (!row) throw new Error("Failed to create server record");

		const ok = await waitForSsh(row.serverId, onLog);
		if (!ok) {
			// Roll back: destroy the VM + row so we don't leak.
			await provisioner.destroyNode(node.providerId).catch(() => {});
			await db
				.delete(serverTable)
				.where(eq(serverTable.serverId, row.serverId));
			throw new Error("New node never became SSH-reachable; rolled back");
		}
		await joinWorkerNode(row.serverId, onLog);
		await stamp();
		return `scaled up: +${name}`;
	}

	// action === "down": pick an autoscaled worker with the fewest running allocs.
	const workers = await db.query.server.findMany({
		where: and(
			eq(serverTable.organizationId, organizationId),
			eq(serverTable.autoscaled, true),
			eq(serverTable.clusterRole, "worker"),
		),
		columns: { serverId: true, name: true, wgIp: true, providerNodeId: true },
	});
	let victim = workers[0];
	if (!victim) return "nothing to scale down";
	try {
		const nodes = (await nomad("/nodes")) as { Address: string; ID: string }[];
		const allocs = (await nomad("/allocations")) as {
			NodeID: string;
			ClientStatus: string;
		}[];
		const countFor = (wgIp: string | null) => {
			const n = nodes.find((x) => x.Address === wgIp);
			if (!n) return 0;
			return allocs.filter(
				(a) => a.NodeID === n.ID && a.ClientStatus === "running",
			).length;
		};
		victim =
			[...workers].sort((a, b) => countFor(a.wgIp) - countFor(b.wgIp))[0] ??
			victim;
	} catch {}

	onLog(`Scaling down: removing ${victim.name}\n`);
	await removeWorkerNode(victim.serverId, onLog);
	if (victim.providerNodeId) {
		const provisioner = getProvisioner({
			provider: cfg.provider,
			token: cfg.token,
			serverType: cfg.serverType,
			location: cfg.location,
			image: cfg.image,
			networkId: cfg.networkId || undefined,
		});
		onLog(`Destroying VM ${victim.providerNodeId} …\n`);
		await provisioner
			.destroyNode(victim.providerNodeId)
			.catch((e) =>
				onLog(`⚠ destroy: ${e instanceof Error ? e.message : String(e)}\n`),
			);
	}
	await db.delete(serverTable).where(eq(serverTable.serverId, victim.serverId));
	await stamp();
	return `scaled down: -${victim.name}`;
};

let looping = false;
/**
 * Periodic driver: every `intervalSeconds`, reconcile every org that has the
 * cluster autoscaler enabled. Non-overlapping (a slow scale-up won't stack) and
 * failure-isolated per org. Started once from the panel server on boot.
 */
export const startAutoscalerLoop = (intervalSeconds = 60): NodeJS.Timeout => {
	const tick = async () => {
		if (looping) return;
		looping = true;
		try {
			const configs = await db.query.clusterAutoscaler.findMany({
				where: eq(clusterAutoscaler.enabled, true),
				columns: { organizationId: true },
			});
			for (const c of configs) {
				await reconcileAutoscaler(c.organizationId, (l) =>
					console.log(`[autoscaler:${c.organizationId}] ${l.trimEnd()}`),
				).catch((e) => console.error(`[autoscaler:${c.organizationId}]`, e));
			}
		} catch (e) {
			console.error("[autoscaler] loop error", e);
		} finally {
			looping = false;
		}
	};
	return setInterval(tick, intervalSeconds * 1000);
};
