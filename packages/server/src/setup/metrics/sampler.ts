import { lt } from "drizzle-orm";
import { db } from "../../db";
import { serviceMetricSample } from "../../db/schema";

// Panel runs co-located with the control plane; the sampler reads Nomad from the
// same env the autoscaler loop uses.
const NOMAD_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const NOMAD_TOKEN = process.env.NOMAD_TOKEN || "";
const RETENTION_DAYS = 7;

const nomad = async (path: string) => {
	const res = await fetch(`${NOMAD_ADDRESS.replace(/\/$/, "")}/v1${path}`, {
		headers: NOMAD_TOKEN ? { "X-Nomad-Token": NOMAD_TOKEN } : {},
	});
	if (!res.ok) throw new Error(`Nomad ${res.status} on ${path}`);
	return res.json();
};

const label = (labels: string, key: string) =>
	labels.match(new RegExp(`${key}="([^"]*)"`))?.[1] ?? "";

const FIELDS: [RegExp, "cpuUsed" | "cpuAlloc" | "memUsed" | "memAlloc"][] = [
	[
		/nomad_client_allocs_cpu_total_ticks\{([^}]*)\}\s+([0-9.eE+-]+)/g,
		"cpuUsed",
	],
	[/nomad_client_allocs_cpu_allocated\{([^}]*)\}\s+([0-9.eE+-]+)/g, "cpuAlloc"],
	[/nomad_client_allocs_memory_usage\{([^}]*)\}\s+([0-9.eE+-]+)/g, "memUsed"],
	[
		/nomad_client_allocs_memory_allocated\{([^}]*)\}\s+([0-9.eE+-]+)/g,
		"memAlloc",
	],
];

/**
 * Scrape every ready node's telemetry once and persist one usage-vs-reserved row
 * per running job (used = cpu_total_ticks / memory_usage, reserved = cpu_allocated
 * / memory_allocated). Prunes rows past the retention window. Returns the number
 * of jobs sampled.
 */
export const sampleServiceMetrics = async (): Promise<number> => {
	const nodes = (await nomad("/nodes")) as { ID: string; Status: string }[];
	const ready = (nodes ?? []).filter((n) => n.Status === "ready");
	const addrs = new Set<string>();
	for (const n of ready) {
		try {
			const d = (await nomad(`/node/${n.ID}`)) as { HTTPAddr?: string };
			if (d.HTTPAddr) addrs.add(d.HTTPAddr);
		} catch {}
	}
	addrs.add(NOMAD_ADDRESS.replace(/^https?:\/\//, "").replace(/\/$/, ""));

	const raw: Record<
		string,
		{ cpuUsed: number; cpuAlloc: number; memUsed: number; memAlloc: number }
	> = {};
	await Promise.all(
		[...addrs].map(async (addr) => {
			try {
				const ctl = new AbortController();
				const t = setTimeout(() => ctl.abort(), 4000);
				const res = await fetch(`http://${addr}/v1/metrics?format=prometheus`, {
					headers: NOMAD_TOKEN ? { "X-Nomad-Token": NOMAD_TOKEN } : {},
					signal: ctl.signal,
				});
				clearTimeout(t);
				if (!res.ok) return;
				const text = await res.text();
				for (const [re, field] of FIELDS) {
					for (const m of text.matchAll(re)) {
						const job = label(m[1] ?? "", "job");
						if (!job) continue;
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
		}),
	);

	const rows = Object.entries(raw)
		.filter(([, v]) => v.cpuAlloc > 0 || v.memAlloc > 0)
		.map(([appName, v]) => ({
			appName,
			cpuUsedMhz: Math.round(v.cpuUsed),
			cpuAllocMhz: Math.round(v.cpuAlloc),
			memUsedMb: Math.round(v.memUsed / (1024 * 1024)),
			memAllocMb: Math.round(v.memAlloc / (1024 * 1024)),
		}));
	if (rows.length > 0) await db.insert(serviceMetricSample).values(rows);

	const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
	await db
		.delete(serviceMetricSample)
		.where(lt(serviceMetricSample.createdAt, cutoff));
	return rows.length;
};

let sampling = false;
/**
 * Periodic driver: sample service metrics every `intervalSeconds`. Non-overlapping
 * and failure-isolated. Started once from the panel server on boot.
 */
export const startMetricsSampler = (intervalSeconds = 300): NodeJS.Timeout => {
	const tick = async () => {
		if (sampling) return;
		sampling = true;
		try {
			await sampleServiceMetrics();
		} catch (e) {
			console.error("[metrics-sampler]", e);
		} finally {
			sampling = false;
		}
	};
	return setInterval(tick, intervalSeconds * 1000);
};
