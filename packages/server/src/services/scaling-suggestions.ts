import { eq, gte } from "drizzle-orm";
import { db } from "../db";
import { projects, serviceMetricSample } from "../db/schema";

export type SuggestionKind = "under_provisioned" | "over_provisioned" | "idle";

export interface ScalingSuggestion {
	appName: string;
	serviceType: string;
	serviceId: string;
	serviceName: string;
	projectId: string;
	projectName: string;
	environmentId: string;
	kind: SuggestionKind;
	/** Human label identifying the service: "name (type) · project". */
	title: string;
	message: string;
	cpuPct: number;
	memPct: number;
	samples: number;
}

const WINDOW_HOURS = 24;
// Require a handful of samples so a just-deployed service or a brief spike doesn't
// trigger a suggestion.
const MIN_SAMPLES = 6;

type Meta = {
	type: string;
	id: string;
	name: string;
	projectId: string;
	projectName: string;
	environmentId: string;
};

/**
 * Analyze the last {WINDOW_HOURS} of sampled usage-vs-reserved per service and
 * surface utilization/scaling suggestions: over-provisioned (wasting reserved
 * capacity), under-provisioned (running hot), or idle. Read by the UI and the
 * daily digest. Cheap: two indexed reads + in-memory aggregation.
 */
export const getScalingSuggestions = async (
	organizationId: string,
): Promise<ScalingSuggestion[]> => {
	const rows = await db.query.projects.findMany({
		where: eq(projects.organizationId, organizationId),
		columns: { projectId: true, name: true },
		with: {
			environments: {
				columns: { environmentId: true },
				with: {
					applications: {
						columns: { appName: true, applicationId: true, name: true },
					},
					compose: { columns: { appName: true, composeId: true, name: true } },
					postgres: {
						columns: { appName: true, postgresId: true, name: true },
					},
					mysql: { columns: { appName: true, mysqlId: true, name: true } },
					mariadb: { columns: { appName: true, mariadbId: true, name: true } },
					mongo: { columns: { appName: true, mongoId: true, name: true } },
					redis: { columns: { appName: true, redisId: true, name: true } },
					libsql: { columns: { appName: true, libsqlId: true, name: true } },
				},
			},
		},
	});

	const meta = new Map<string, Meta>();
	for (const p of rows) {
		for (const env of p.environments) {
			const push = (type: string, id: string, name: string, appName: string) =>
				meta.set(appName, {
					type,
					id,
					name,
					projectId: p.projectId,
					projectName: p.name,
					environmentId: env.environmentId,
				});
			for (const a of env.applications)
				push("application", a.applicationId, a.name, a.appName);
			for (const c of env.compose)
				push("compose", c.composeId, c.name, c.appName);
			for (const s of env.postgres)
				push("postgres", s.postgresId, s.name, s.appName);
			for (const s of env.mysql) push("mysql", s.mysqlId, s.name, s.appName);
			for (const s of env.mariadb)
				push("mariadb", s.mariadbId, s.name, s.appName);
			for (const s of env.mongo) push("mongo", s.mongoId, s.name, s.appName);
			for (const s of env.redis) push("redis", s.redisId, s.name, s.appName);
			for (const s of env.libsql) push("libsql", s.libsqlId, s.name, s.appName);
		}
	}
	if (meta.size === 0) return [];

	const cutoff = new Date(Date.now() - WINDOW_HOURS * 3600000).toISOString();
	const samples = await db.query.serviceMetricSample.findMany({
		where: gte(serviceMetricSample.createdAt, cutoff),
		columns: {
			appName: true,
			cpuUsedMhz: true,
			cpuAllocMhz: true,
			memUsedMb: true,
			memAllocMb: true,
		},
	});

	const agg = new Map<
		string,
		{ cpuU: number; cpuA: number; memU: number; memA: number; n: number }
	>();
	for (const s of samples) {
		if (!meta.has(s.appName)) continue;
		const g = agg.get(s.appName) ?? {
			cpuU: 0,
			cpuA: 0,
			memU: 0,
			memA: 0,
			n: 0,
		};
		g.cpuU += s.cpuUsedMhz;
		g.cpuA += s.cpuAllocMhz;
		g.memU += s.memUsedMb;
		g.memA += s.memAllocMb;
		g.n += 1;
		agg.set(s.appName, g);
	}

	const out: ScalingSuggestion[] = [];
	for (const [appName, g] of agg) {
		if (g.n < MIN_SAMPLES) continue;
		const m = meta.get(appName);
		if (!m) continue;
		const cpuPct = g.cpuA > 0 ? Math.round((g.cpuU / g.cpuA) * 100) : 0;
		const memPct = g.memA > 0 ? Math.round((g.memU / g.memA) * 100) : 0;
		const base = {
			appName,
			serviceType: m.type,
			serviceId: m.id,
			serviceName: m.name,
			projectId: m.projectId,
			projectName: m.projectName,
			environmentId: m.environmentId,
			title: `${m.name} (${m.type}) · ${m.projectName}`,
			cpuPct,
			memPct,
			samples: g.n,
		};
		const usage = `CPU ${cpuPct}%, mem ${memPct}% of reserved over ${WINDOW_HOURS}h`;
		if (cpuPct <= 5 && memPct <= 5) {
			out.push({
				...base,
				kind: "idle",
				message: `Idle — ${usage}. Consider stopping it.`,
			});
		} else if (cpuPct >= 85 || memPct >= 85) {
			out.push({
				...base,
				kind: "under_provisioned",
				message: `Running hot — ${usage}. Raise reserved resources or enable autoscaling.`,
			});
		} else if (cpuPct < 15 && memPct < 40) {
			out.push({
				...base,
				kind: "over_provisioned",
				message: `Over-provisioned — ${usage}. Consider lowering reserved CPU/memory.`,
			});
		}
	}

	// Most urgent first: running hot, then waste, then idle.
	const order: Record<SuggestionKind, number> = {
		under_provisioned: 0,
		over_provisioned: 1,
		idle: 2,
	};
	out.sort((a, b) => order[a.kind] - order[b.kind]);
	return out;
};
