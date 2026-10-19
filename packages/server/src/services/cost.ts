import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { paths } from "../constants";
import { db } from "../db";
import { clusterAutoscaler, cloudProvider } from "../db/schema";
import {
	findAllServicesCentralized,
	type OverviewServiceType,
} from "./overview";

/**
 * Cost reporting. Two layers:
 *  - infra cost: each live Nomad node's monthly price (from a per-server-type price
 *    map, or a per-node override), summed into a cluster run-rate;
 *  - showback: that cost allocated to services by their RESERVED CPU+mem share of
 *    the node they run on (blended 50/50), rolled up to projects/environments.
 *    Idle capacity a node is paying for but nothing reserves shows as "unallocated".
 *
 * Reserved (not live-used) is the basis by design: it's deterministic and matches
 * how Nomad binpacks nodes — i.e. what you actually pay to keep scheduled.
 */
const NOMAD_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const NOMAD_TOKEN = process.env.NOMAD_TOKEN || "";

const nomad = async <T>(p: string): Promise<T> => {
	const res = await fetch(`${NOMAD_ADDRESS.replace(/\/$/, "")}/v1${p}`, {
		headers: NOMAD_TOKEN ? { "X-Nomad-Token": NOMAD_TOKEN } : {},
	});
	if (!res.ok) throw new Error(`Nomad ${res.status} on ${p}`);
	return res.json() as Promise<T>;
};

export type CostConfig = {
	currency: string;
	/** €/month per Hetzner-style server type (e.g. cpx22). */
	typePrices: Record<string, number>;
	/** €/month override per Nomad node name (hub + manual nodes that have no type). */
	nodePrices: Record<string, number>;
};

const DEFAULT_CONFIG: CostConfig = {
	currency: "EUR",
	typePrices: {},
	nodePrices: {},
};

const configPath = (): string =>
	path.join(paths().MAIN_TRAEFIK_PATH, "..", "cost", "config.json");

export const getCostConfig = (): CostConfig => {
	try {
		const parsed = JSON.parse(
			readFileSync(configPath(), "utf8"),
		) as Partial<CostConfig>;
		return {
			currency:
				typeof parsed.currency === "string" && parsed.currency
					? parsed.currency
					: "EUR",
			typePrices:
				parsed.typePrices && typeof parsed.typePrices === "object"
					? parsed.typePrices
					: {},
			nodePrices:
				parsed.nodePrices && typeof parsed.nodePrices === "object"
					? parsed.nodePrices
					: {},
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
};

export const setCostConfig = (cfg: CostConfig): CostConfig => {
	const normalize = (m: Record<string, number>): Record<string, number> =>
		Object.fromEntries(
			Object.entries(m)
				.map(([k, v]) => [k, Number(v)] as const)
				.filter(([, v]) => Number.isFinite(v) && v >= 0),
		);
	const normalized: CostConfig = {
		currency: cfg.currency?.trim() || "EUR",
		typePrices: normalize(cfg.typePrices ?? {}),
		nodePrices: normalize(cfg.nodePrices ?? {}),
	};
	const file = configPath();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(normalized, null, 2), "utf8");
	return normalized;
};

// ── Report shapes ──────────────────────────────────────────────────────────

export interface CostNode {
	id: string;
	name: string;
	nodePool: string;
	/** Resolved server type (from the node's autoscale pool), if any. */
	serverType: string | null;
	/** €/month used for this node (0 when unpriced). */
	monthly: number;
	/** How the price was resolved — surfaced so the UI can flag unpriced nodes. */
	priceSource: "node" | "type" | "none";
	cpuCapacity: number;
	memCapacity: number;
	cpuReservedPct: number;
	memReservedPct: number;
}

export interface CostService {
	appName: string;
	name: string;
	type: OverviewServiceType;
	projectId: string;
	projectName: string;
	environmentName: string;
	monthly: number;
}

export interface CostProject {
	projectId: string;
	projectName: string;
	monthly: number;
	services: CostService[];
}

export interface CostReport {
	currency: string;
	/** Cluster run-rate = sum of node monthly prices. */
	totalMonthly: number;
	/** Cost attributed to services (by reserved share). */
	allocatedMonthly: number;
	/** totalMonthly − allocatedMonthly: idle headroom + unmapped system jobs. */
	unallocatedMonthly: number;
	/** Nodes with no price set — the run-rate undercounts until these are priced. */
	unpricedNodes: string[];
	nodes: CostNode[];
	projects: CostProject[];
}

interface NodeStub {
	ID: string;
	Name?: string;
	Status: string;
	SchedulingEligibility: string;
	NodePool?: string;
}
interface NodeDetail {
	NodeResources?: {
		Cpu?: { CpuShares?: number };
		Memory?: { MemoryMB?: number };
	};
}
interface AllocStub {
	NodeID?: string;
	JobID?: string;
	ClientStatus: string;
	AllocatedResources?: {
		Tasks?: Record<
			string,
			{ Cpu?: { CpuShares?: number }; Memory?: { MemoryMB?: number } }
		>;
	};
}

/**
 * Compute the cost report for an org. Node pricing is cluster-wide (prices are set
 * per server type / node); the per-service rollup is scoped to the services the
 * caller may see (`accessedServices`, as the Overview does).
 */
export const computeCostReport = async (
	orgId: string,
	accessedServices: string[] | null,
): Promise<CostReport> => {
	const cfg = getCostConfig();

	// Pool → server type, from this org's autoscale groups (first type wins).
	const groups = await db
		.select({
			poolName: clusterAutoscaler.poolName,
			serverType: clusterAutoscaler.serverType,
		})
		.from(clusterAutoscaler)
		.where(eq(clusterAutoscaler.organizationId, orgId));
	const poolType = new Map<string, string>();
	for (const g of groups) {
		const first = (g.serverType || "").split(",")[0]?.trim();
		if (first) poolType.set(g.poolName, first);
	}

	const nodes = await nomad<NodeStub[]>("/nodes");
	const ready = nodes.filter(
		(n) => n.Status === "ready" && n.SchedulingEligibility === "eligible",
	);

	const costNodes: CostNode[] = [];
	const nodeById = new Map<
		string,
		{ monthly: number; cpuCap: number; memCap: number }
	>();
	const unpriced: string[] = [];

	for (const n of ready) {
		const name = n.Name || n.ID.slice(0, 8);
		const pool = n.NodePool || "default";
		const serverType = poolType.get(pool) ?? null;
		let monthly = 0;
		let priceSource: CostNode["priceSource"] = "none";
		if (cfg.nodePrices[name] != null) {
			monthly = cfg.nodePrices[name] ?? 0;
			priceSource = "node";
		} else if (serverType && cfg.typePrices[serverType] != null) {
			monthly = cfg.typePrices[serverType] ?? 0;
			priceSource = "type";
		}
		if (priceSource === "none" || monthly <= 0) unpriced.push(name);

		let cpuCap = 0;
		let memCap = 0;
		try {
			const d = await nomad<NodeDetail>(`/node/${n.ID}`);
			cpuCap = d.NodeResources?.Cpu?.CpuShares || 0;
			memCap = d.NodeResources?.Memory?.MemoryMB || 0;
		} catch {}

		nodeById.set(n.ID, { monthly, cpuCap, memCap });
		costNodes.push({
			id: n.ID,
			name,
			nodePool: pool,
			serverType,
			monthly,
			priceSource,
			cpuCapacity: cpuCap,
			memCapacity: memCap,
			cpuReservedPct: 0,
			memReservedPct: 0,
		});
	}

	// Running allocs with reserved resources, grouped onto their node.
	const allocs = await nomad<AllocStub[]>("/allocations?resources=true");
	const perNodeReserved = new Map<string, { cpu: number; mem: number }>();
	const costByApp = new Map<string, number>();
	for (const a of allocs) {
		if (a.ClientStatus !== "running" || !a.NodeID || !a.JobID) continue;
		const node = nodeById.get(a.NodeID);
		if (!node) continue;
		let cpu = 0;
		let mem = 0;
		for (const t of Object.values(a.AllocatedResources?.Tasks || {})) {
			cpu += t?.Cpu?.CpuShares || 0;
			mem += t?.Memory?.MemoryMB || 0;
		}
		const agg = perNodeReserved.get(a.NodeID) ?? { cpu: 0, mem: 0 };
		agg.cpu += cpu;
		agg.mem += mem;
		perNodeReserved.set(a.NodeID, agg);

		// Blend the node's monthly cost 50/50 across CPU and mem capacity shares.
		const cpuShare = node.cpuCap > 0 ? cpu / node.cpuCap : 0;
		const memShare = node.memCap > 0 ? mem / node.memCap : 0;
		const allocCost = node.monthly * 0.5 * (cpuShare + memShare);
		costByApp.set(a.JobID, (costByApp.get(a.JobID) ?? 0) + allocCost);
	}

	// Fill each node's reserved % now that we've summed allocs.
	for (const cn of costNodes) {
		const r = perNodeReserved.get(cn.id);
		cn.cpuReservedPct =
			cn.cpuCapacity > 0 && r
				? Math.round((r.cpu / cn.cpuCapacity) * 100)
				: 0;
		cn.memReservedPct =
			cn.memCapacity > 0 && r
				? Math.round((r.mem / cn.memCapacity) * 100)
				: 0;
	}

	// Map appName → service (with project/env), aggregate per service + project.
	const services = await findAllServicesCentralized(orgId, accessedServices);
	const byApp = new Map<string, (typeof services)[number]>();
	for (const s of services) if (s.appName) byApp.set(s.appName, s);

	const serviceRows: CostService[] = [];
	for (const [appName, monthly] of costByApp) {
		const svc = byApp.get(appName);
		if (!svc) continue; // system/raw jobs with no panel service → unallocated
		serviceRows.push({
			appName,
			name: svc.name,
			type: svc.type,
			projectId: svc.projectId,
			projectName: svc.projectName,
			environmentName: svc.environmentName,
			monthly: Math.round(monthly * 100) / 100,
		});
	}

	const projMap = new Map<string, CostProject>();
	for (const s of serviceRows) {
		const p = projMap.get(s.projectId) ?? {
			projectId: s.projectId,
			projectName: s.projectName,
			monthly: 0,
			services: [],
		};
		p.services.push(s);
		p.monthly = Math.round((p.monthly + s.monthly) * 100) / 100;
		projMap.set(s.projectId, p);
	}
	const projects = [...projMap.values()].sort((a, b) => b.monthly - a.monthly);
	for (const p of projects)
		p.services.sort((a, b) => b.monthly - a.monthly);

	const totalMonthly =
		Math.round(costNodes.reduce((s, n) => s + n.monthly, 0) * 100) / 100;
	const allocatedMonthly =
		Math.round([...costByApp.values()].reduce((s, v) => s + v, 0) * 100) / 100;

	return {
		currency: cfg.currency,
		totalMonthly,
		allocatedMonthly,
		unallocatedMonthly:
			Math.round((totalMonthly - allocatedMonthly) * 100) / 100,
		unpricedNodes: unpriced,
		nodes: costNodes.sort((a, b) => b.monthly - a.monthly),
		projects,
	};
};

/**
 * Best-effort price suggestions from Hetzner: for each distinct server type used by
 * this org's Hetzner autoscale groups, fetch its monthly net price. Returns a
 * {type: €/month} map to prefill the price form. Never throws — a missing token or
 * API error just yields fewer suggestions.
 */
export const suggestHetznerPrices = async (
	orgId: string,
): Promise<Record<string, number>> => {
	const groups = await db
		.select({
			serverType: clusterAutoscaler.serverType,
			location: clusterAutoscaler.location,
			provider: clusterAutoscaler.provider,
			cloudProviderId: clusterAutoscaler.cloudProviderId,
			token: clusterAutoscaler.token,
		})
		.from(clusterAutoscaler)
		.where(eq(clusterAutoscaler.organizationId, orgId));

	const out: Record<string, number> = {};
	for (const g of groups) {
		if ((g.provider || "hetzner") !== "hetzner") continue;
		let token = g.token || "";
		if (!token && g.cloudProviderId) {
			const cp = await db
				.select({ token: cloudProvider.token })
				.from(cloudProvider)
				.where(eq(cloudProvider.cloudProviderId, g.cloudProviderId))
				.limit(1);
			token = cp[0]?.token ?? "";
		}
		if (!token) continue;
		try {
			const res = await fetch(
				"https://api.hetzner.cloud/v1/server_types?per_page=100",
				{ headers: { Authorization: `Bearer ${token}` } },
			);
			if (!res.ok) continue;
			const body = (await res.json()) as {
				server_types: {
					name: string;
					prices?: {
						location: string;
						price_monthly?: { net?: string };
					}[];
				}[];
			};
			const want = new Set(
				(g.serverType || "")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			);
			for (const st of body.server_types) {
				if (!want.has(st.name)) continue;
				const byLoc =
					st.prices?.find((p) => p.location === g.location) ?? st.prices?.[0];
				const net = Number(byLoc?.price_monthly?.net);
				if (Number.isFinite(net) && net > 0)
					out[st.name] = Math.round(net * 100) / 100;
			}
		} catch {
			// best-effort
		}
	}
	return out;
};
