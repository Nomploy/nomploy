import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "../db";
import {
	cloudProvider,
	dnsProvider,
	lbMetricSample,
	loadBalancer,
	server,
} from "../db/schema";
import { syncTraefikCertsToConsulKV, TRAEFIK_HA_JOB_NAME } from "./traefik-ha";

const HETZNER_API = "https://api.hetzner.cloud/v1";

const NOMAD_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const NOMAD_TOKEN = process.env.NOMAD_TOKEN || "";
const CF_API = "https://api.cloudflare.com/client/v4";
// Traefik's Prometheus entryPoint on each pool node (see generateTraefikHaJob).
const METRICS_PORT = 8082;

const nomad = async <T>(path: string): Promise<T> => {
	const res = await fetch(`${NOMAD_ADDRESS.replace(/\/$/, "")}/v1${path}`, {
		headers: NOMAD_TOKEN ? { "X-Nomad-Token": NOMAD_TOKEN } : {},
	});
	if (!res.ok) throw new Error(`Nomad ${res.status} on ${path}`);
	return res.json() as Promise<T>;
};

// DNS-safe lowercase alphanumeric id (no _/- so it can't produce an invalid label).
const dnsSafeId = (n = 6): string => {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < n; i++)
		s += alphabet[Math.floor(Math.random() * alphabet.length)];
	return s;
};

export const generateLbHostname = (zone: string): string =>
	`lb-${dnsSafeId()}.${zone}`;

// ---------------------------------------------------------------------------
// Cloudflare API
// ---------------------------------------------------------------------------

type CfResult<T> = {
	success: boolean;
	result: T;
	errors?: { message: string }[];
};
type CfZone = { id: string; name: string };
type CfRecord = { id: string; type: string; name: string; content: string };

const cf = async <T>(
	token: string,
	path: string,
	init?: RequestInit,
): Promise<T> => {
	const res = await fetch(`${CF_API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const data = (await res.json()) as CfResult<T>;
	if (!res.ok || !data.success) {
		throw new Error(
			data.errors?.[0]?.message || `Cloudflare API error ${res.status}`,
		);
	}
	return data.result;
};

/** List the zones a token can manage (used to pick/validate the LB zone). */
export const cfListZones = (token: string): Promise<CfZone[]> =>
	cf<CfZone[]>(token, "/zones?per_page=50");

const cfZoneId = async (token: string, zoneName: string): Promise<string> => {
	const zones = await cf<CfZone[]>(
		token,
		`/zones?name=${encodeURIComponent(zoneName)}`,
	);
	const zone = zones.find((z) => z.name === zoneName) ?? zones[0];
	if (!zone) throw new Error(`No Cloudflare zone found for "${zoneName}"`);
	return zone.id;
};

// ---------------------------------------------------------------------------
// Pool membership + health
// ---------------------------------------------------------------------------

export type LbNode = {
	node: string;
	status: string;
	healthy: boolean;
	/** The server row's stored address (often a private/Hetzner-network IP). */
	ip: string | null;
	/** The internet-routable IP to publish in DNS (Hetzner-detected, else `ip` if public). */
	publicIp: string | null;
	wgIp: string | null;
};

type Alloc = {
	NodeName: string;
	NodeID: string;
	ClientStatus: string;
	DesiredStatus: string;
};

const isPrivateIp = (ip: string): boolean =>
	/^10\./.test(ip) ||
	/^127\./.test(ip) ||
	/^169\.254\./.test(ip) ||
	/^192\.168\./.test(ip) ||
	/^172\.(1[6-9]|2\d|3[01])\./.test(ip);

// Cache the Hetzner server list briefly — resolveLbNodes runs on every UI poll.
let hetznerIpCache: {
	org: string;
	ts: number;
	byPrivate: Map<string, string>;
	byName: Map<string, string>;
} | null = null;
const HETZNER_CACHE_MS = 60_000;

type HetznerServer = {
	name: string;
	public_net?: { ipv4?: { ip?: string } | null };
	private_net?: { ip?: string }[];
};

/**
 * Build an index of {private IP → public IPv4} and {name → public IPv4} across the
 * org's Hetzner accounts, so a node's private `server.ipAddress` can be resolved
 * to the routable IP the LB must publish. Cached ~60s; empty on any failure.
 */
const hetznerPublicIpIndex = async (
	organizationId: string,
): Promise<{ byPrivate: Map<string, string>; byName: Map<string, string> }> => {
	if (
		hetznerIpCache &&
		hetznerIpCache.org === organizationId &&
		Date.now() - hetznerIpCache.ts < HETZNER_CACHE_MS
	) {
		return hetznerIpCache;
	}
	const byPrivate = new Map<string, string>();
	const byName = new Map<string, string>();
	try {
		const accounts = await db.query.cloudProvider.findMany({
			where: and(
				eq(cloudProvider.organizationId, organizationId),
				eq(cloudProvider.provider, "hetzner"),
			),
			columns: { token: true },
		});
		for (const acc of accounts) {
			if (!acc.token) continue;
			try {
				const res = await fetch(`${HETZNER_API}/servers?per_page=50`, {
					headers: { Authorization: `Bearer ${acc.token}` },
				});
				if (!res.ok) continue;
				const data = (await res.json()) as { servers?: HetznerServer[] };
				for (const s of data.servers ?? []) {
					const pub = s.public_net?.ipv4?.ip;
					if (!pub) continue;
					if (s.name) byName.set(s.name, pub);
					for (const pn of s.private_net ?? []) {
						if (pn.ip) byPrivate.set(pn.ip, pub);
					}
				}
			} catch {
				// try the next account
			}
		}
	} catch {
		// no cloud providers / db issue → empty index
	}
	hetznerIpCache = { org: organizationId, ts: Date.now(), byPrivate, byName };
	return { byPrivate, byName };
};

/**
 * Resolve the pool's current members: the running system-job allocs mapped to
 * their server rows (public + wg IPs). A node is healthy when Nomad still wants
 * its alloc running and the client reports it running — the DNS failover signal.
 *
 * Nomad's NodeName is the host's own hostname and need not equal the panel's
 * `server.name` (which the user picks), so we match primarily by **wg IP** —
 * derived from the node's HTTPAddr (Nomad binds its API on the wg overlay) and
 * matched against `server.wgIp`. That also gives metrics a scrape host even when
 * the server row can't be matched at all. Name match is the fallback.
 */
export const resolveLbNodes = async (
	organizationId: string,
): Promise<LbNode[]> => {
	let allocs: Alloc[] = [];
	try {
		allocs = await nomad<Alloc[]>(`/job/${TRAEFIK_HA_JOB_NAME}/allocations`);
	} catch {
		return [];
	}
	const live = allocs.filter((a) => a.DesiredStatus === "run");
	const servers = await db.query.server.findMany({
		where: eq(server.organizationId, organizationId),
	});
	const normIp = (ip: string) => ip.split("/")[0];
	const byName = new Map(servers.map((s) => [s.name, s]));
	const byWg = new Map(
		servers.filter((s) => s.wgIp).map((s) => [normIp(s.wgIp as string), s]),
	);

	// Derive each node's wg IP from its Nomad HTTPAddr (host part).
	const wgByNode = new Map<string, string>();
	await Promise.all(
		[...new Set(live.map((a) => a.NodeID))].map(async (id) => {
			try {
				const n = await nomad<{ Name?: string; HTTPAddr?: string }>(
					`/node/${id}`,
				);
				const host = n.HTTPAddr?.split(":")[0];
				if (n.Name && host) wgByNode.set(n.Name, host);
			} catch {
				// leave unmapped; falls back to server row / name
			}
		}),
	);

	const hz = await hetznerPublicIpIndex(organizationId);

	// De-dup by node (system job = one alloc per node, but be defensive).
	const seen = new Set<string>();
	const out: LbNode[] = [];
	for (const a of live) {
		if (seen.has(a.NodeName)) continue;
		seen.add(a.NodeName);
		const derivedWg = wgByNode.get(a.NodeName) ?? null;
		const s =
			(derivedWg ? byWg.get(derivedWg) : undefined) ?? byName.get(a.NodeName);
		const ip = s?.ipAddress ?? null;
		// Prefer a Hetzner-detected public IP (match by private IP, then name);
		// fall back to the stored IP only when it is itself already public.
		const publicIp =
			(ip ? hz.byPrivate.get(ip) : undefined) ??
			hz.byName.get(a.NodeName) ??
			(s?.name ? hz.byName.get(s.name) : undefined) ??
			(ip && !isPrivateIp(ip) ? ip : null) ??
			null;
		out.push({
			node: a.NodeName,
			status: a.ClientStatus,
			healthy: a.ClientStatus === "running",
			ip,
			publicIp,
			wgIp: derivedWg ?? s?.wgIp ?? null,
		});
	}
	return out;
};

// ---------------------------------------------------------------------------
// Reconcile: A records == healthy nodes' public IPs
// ---------------------------------------------------------------------------

export type LbReconcileResult = {
	hostname: string;
	desired: string[];
	created: string[];
	removed: string[];
};

export const reconcileLoadBalancerDns = async (
	organizationId: string,
): Promise<LbReconcileResult> => {
	const lb = await db.query.loadBalancer.findFirst({
		where: eq(loadBalancer.organizationId, organizationId),
	});
	if (!lb) throw new Error("Load balancer is not configured");
	if (!lb.dnsProviderId) throw new Error("No DNS provider selected");
	const provider = await db.query.dnsProvider.findFirst({
		where: and(
			eq(dnsProvider.dnsProviderId, lb.dnsProviderId),
			eq(dnsProvider.organizationId, organizationId),
		),
	});
	if (!provider?.token) throw new Error("DNS provider has no token");

	const nodes = await resolveLbNodes(organizationId);
	const desired = [
		...new Set(
			nodes
				.filter((n) => n.healthy && n.publicIp)
				.map((n) => n.publicIp as string),
		),
	].sort();

	const token = provider.token;
	const zoneId = await cfZoneId(token, lb.zoneName);
	const existing = await cf<CfRecord[]>(
		token,
		`/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(lb.hostname)}&per_page=100`,
	);

	const existingIps = new Set(existing.map((r) => r.content));
	const desiredSet = new Set(desired);

	const created: string[] = [];
	const removed: string[] = [];

	// Create missing A records.
	for (const ip of desired) {
		if (existingIps.has(ip)) continue;
		await cf(token, `/zones/${zoneId}/dns_records`, {
			method: "POST",
			body: JSON.stringify({
				type: "A",
				name: lb.hostname,
				content: ip,
				ttl: lb.ttl,
				proxied: false,
			}),
		});
		created.push(ip);
	}
	// Remove A records no longer desired.
	for (const r of existing) {
		if (desiredSet.has(r.content)) continue;
		await cf(token, `/zones/${zoneId}/dns_records/${r.id}`, {
			method: "DELETE",
		});
		removed.push(r.content);
	}

	const status =
		desired.length === 0
			? "No healthy nodes — all A records pruned"
			: `${desired.length} node(s) in DNS`;
	await db
		.update(loadBalancer)
		.set({ lastReconcileAt: new Date(), lastReconcileStatus: status })
		.where(eq(loadBalancer.organizationId, organizationId));

	return { hostname: lb.hostname, desired, created, removed };
};

/** Remove every LB A record (used when DNS management is disabled). */
export const clearLoadBalancerDns = async (
	organizationId: string,
): Promise<void> => {
	const lb = await db.query.loadBalancer.findFirst({
		where: eq(loadBalancer.organizationId, organizationId),
	});
	if (!lb?.dnsProviderId) return;
	const provider = await db.query.dnsProvider.findFirst({
		where: eq(dnsProvider.dnsProviderId, lb.dnsProviderId),
	});
	if (!provider?.token) return;
	const token = provider.token;
	const zoneId = await cfZoneId(token, lb.zoneName);
	const existing = await cf<CfRecord[]>(
		token,
		`/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(lb.hostname)}&per_page=100`,
	);
	for (const r of existing) {
		await cf(token, `/zones/${zoneId}/dns_records/${r.id}`, {
			method: "DELETE",
		});
	}
};

// ---------------------------------------------------------------------------
// Metrics (Traefik Prometheus, scraped per node over the wg mesh)
// ---------------------------------------------------------------------------

export type LbNodeMetrics = {
	node: string;
	ip: string | null;
	healthy: boolean;
	inDns: boolean;
	reachable: boolean;
	requests: number;
	req2xx: number;
	req4xx: number;
	req5xx: number;
	avgLatencyMs: number;
	reqPerSec: number;
};

// Per-node last sample, to derive request rate between polls.
const lastSample = new Map<string, { ts: number; total: number }>();

const sumMetric = (body: string, metric: string): number => {
	let total = 0;
	const re = new RegExp(`^${metric}\\{([^}]*)\\}\\s+([0-9.eE+-]+)`, "gm");
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = re.exec(body)) !== null) total += Number(m[2]) || 0;
	return total;
};

const sumByCodeClass = (body: string): Record<string, number> => {
	const out: Record<string, number> = { "2": 0, "3": 0, "4": 0, "5": 0 };
	const re = /traefik_entrypoint_requests_total\{([^}]*)\}\s+([0-9.eE+-]+)/gm;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = re.exec(body)) !== null) {
		const code = m[1]?.match(/code="(\d)/)?.[1];
		if (code && out[code] !== undefined) out[code] += Number(m[2]) || 0;
	}
	return out;
};

type RawCounters = {
	reqTotal: number;
	req2xx: number;
	req4xx: number;
	req5xx: number;
	durSum: number;
	durCount: number;
};

/** Scrape a node's Traefik Prometheus endpoint into cumulative counters. */
const scrapeRawCounters = async (host: string): Promise<RawCounters | null> => {
	try {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), 4000);
		const res = await fetch(`http://${host}:${METRICS_PORT}/metrics`, {
			signal: ctl.signal,
		});
		clearTimeout(t);
		if (!res.ok) return null;
		const body = await res.text();
		const classes = sumByCodeClass(body);
		return {
			reqTotal: sumMetric(body, "traefik_entrypoint_requests_total"),
			req2xx: classes["2"] ?? 0,
			req4xx: classes["4"] ?? 0,
			req5xx: classes["5"] ?? 0,
			durSum: sumMetric(
				body,
				"traefik_entrypoint_request_duration_seconds_sum",
			),
			durCount: sumMetric(
				body,
				"traefik_entrypoint_request_duration_seconds_count",
			),
		};
	} catch {
		return null;
	}
};

const scrapeNode = async (
	n: LbNode,
	inDns: boolean,
): Promise<LbNodeMetrics> => {
	const host = n.wgIp || n.ip;
	const base: LbNodeMetrics = {
		node: n.node,
		ip: n.publicIp ?? n.ip,
		healthy: n.healthy,
		inDns,
		reachable: false,
		requests: 0,
		req2xx: 0,
		req4xx: 0,
		req5xx: 0,
		avgLatencyMs: 0,
		reqPerSec: 0,
	};
	if (!host) return base;
	const c = await scrapeRawCounters(host);
	if (!c) return base;

	// Request rate from the delta since the previous poll for this node.
	const now = Date.now();
	const prev = lastSample.get(n.node);
	let reqPerSec = 0;
	if (prev && now > prev.ts && c.reqTotal >= prev.total) {
		reqPerSec = (c.reqTotal - prev.total) / ((now - prev.ts) / 1000);
	}
	lastSample.set(n.node, { ts: now, total: c.reqTotal });

	return {
		...base,
		reachable: true,
		requests: c.reqTotal,
		req2xx: c.req2xx,
		req4xx: c.req4xx,
		req5xx: c.req5xx,
		avgLatencyMs: c.durCount > 0 ? (c.durSum / c.durCount) * 1000 : 0,
		reqPerSec,
	};
};

export const getLoadBalancerMetrics = async (
	organizationId: string,
): Promise<LbNodeMetrics[]> => {
	const nodes = await resolveLbNodes(organizationId);
	const lb = await db.query.loadBalancer.findFirst({
		where: eq(loadBalancer.organizationId, organizationId),
	});
	// Best-effort: which IPs are currently in DNS (skip if not configured).
	let inDnsIps = new Set<string>();
	if (lb?.enabled && lb.dnsProviderId) {
		try {
			const provider = await db.query.dnsProvider.findFirst({
				where: eq(dnsProvider.dnsProviderId, lb.dnsProviderId),
			});
			if (provider?.token) {
				const zoneId = await cfZoneId(provider.token, lb.zoneName);
				const recs = await cf<CfRecord[]>(
					provider.token,
					`/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(lb.hostname)}&per_page=100`,
				);
				inDnsIps = new Set(recs.map((r) => r.content));
			}
		} catch {
			// leave inDns empty on any DNS lookup failure
		}
	}
	return Promise.all(
		nodes.map((n) => scrapeNode(n, !!(n.publicIp && inDnsIps.has(n.publicIp)))),
	);
};

// ---------------------------------------------------------------------------
// Metrics history (sampled time-series → time-range graphs)
// ---------------------------------------------------------------------------

const METRICS_RETENTION_DAYS = 7;

/** Scrape every pool node's cumulative counters once and persist a sample row
 * per node, for each org that has pool nodes. Prunes past the retention window. */
export const sampleLoadBalancerMetrics = async (): Promise<number> => {
	const orgRows = await db
		.selectDistinct({ organizationId: server.organizationId })
		.from(server);
	let written = 0;
	for (const { organizationId } of orgRows) {
		try {
			const nodes = await resolveLbNodes(organizationId);
			for (const n of nodes) {
				const host = n.wgIp || n.ip;
				if (!host) continue;
				const c = await scrapeRawCounters(host);
				if (!c) continue;
				await db.insert(lbMetricSample).values({
					organizationId,
					node: n.node,
					reqTotal: c.reqTotal,
					req2xx: c.req2xx,
					req4xx: c.req4xx,
					req5xx: c.req5xx,
					durSum: c.durSum,
					durCount: c.durCount,
				});
				written++;
			}
		} catch (e) {
			console.error(
				`loadbalancer-metrics: sample failed for org ${organizationId}:`,
				e,
			);
		}
	}
	const cutoff = new Date(Date.now() - METRICS_RETENTION_DAYS * 86400_000);
	await db.delete(lbMetricSample).where(lt(lbMetricSample.ts, cutoff));
	return written;
};

export type LbMetricPoint = {
	ts: number;
	reqPerSec: number;
	req2xxPerSec: number;
	req4xxPerSec: number;
	req5xxPerSec: number;
	latencyMs: number;
};

/**
 * Build a pool-wide time series over the last `minutes`, from the sampled
 * cumulative counters: diff consecutive samples per node into rates (clamping
 * counter resets), then aggregate across nodes into per-timestamp buckets.
 */
export const getLoadBalancerMetricsHistory = async (
	organizationId: string,
	minutes: number,
): Promise<LbMetricPoint[]> => {
	const since = new Date(Date.now() - minutes * 60_000);
	const rows = await db
		.select()
		.from(lbMetricSample)
		.where(
			and(
				eq(lbMetricSample.organizationId, organizationId),
				gte(lbMetricSample.ts, since),
			),
		)
		.orderBy(asc(lbMetricSample.ts));

	// Group by node, diff consecutive samples into per-interval rates.
	const byNode = new Map<string, typeof rows>();
	for (const r of rows) {
		const arr = byNode.get(r.node) ?? [];
		arr.push(r);
		byNode.set(r.node, arr);
	}

	// Bucket rates by sample timestamp (rounded to 60s) and sum across nodes.
	const buckets = new Map<
		number,
		{
			req: number;
			r2: number;
			r4: number;
			r5: number;
			latWeighted: number;
			latWeight: number;
		}
	>();
	const bucketMs = 60_000;
	for (const arr of byNode.values()) {
		for (let i = 1; i < arr.length; i++) {
			const a = arr[i - 1];
			const b = arr[i];
			if (!a || !b) continue;
			const dt = (b.ts.getTime() - a.ts.getTime()) / 1000;
			if (dt <= 0) continue;
			const d = (x: number, y: number) => (y >= x ? y - x : y); // clamp resets
			const req = d(a.reqTotal, b.reqTotal) / dt;
			const r2 = d(a.req2xx, b.req2xx) / dt;
			const r4 = d(a.req4xx, b.req4xx) / dt;
			const r5 = d(a.req5xx, b.req5xx) / dt;
			const dCount = d(a.durCount, b.durCount);
			const dSum = d(a.durSum, b.durSum);
			const lat = dCount > 0 ? (dSum / dCount) * 1000 : 0;
			const key = Math.round(b.ts.getTime() / bucketMs) * bucketMs;
			const cur = buckets.get(key) ?? {
				req: 0,
				r2: 0,
				r4: 0,
				r5: 0,
				latWeighted: 0,
				latWeight: 0,
			};
			cur.req += req;
			cur.r2 += r2;
			cur.r4 += r4;
			cur.r5 += r5;
			cur.latWeighted += lat * Math.max(req, 0.001);
			cur.latWeight += Math.max(req, 0.001);
			buckets.set(key, cur);
		}
	}

	return [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([ts, v]) => ({
			ts,
			reqPerSec: v.req,
			req2xxPerSec: v.r2,
			req4xxPerSec: v.r4,
			req5xxPerSec: v.r5,
			latencyMs: v.latWeight > 0 ? v.latWeighted / v.latWeight : 0,
		}));
};

/**
 * Periodically re-seed the pool's shared certs from the hub's acme.json into
 * Consul KV, so renewed certs propagate to the pool without a manual "Sync
 * certs" click. No-op unless the pool is deployed.
 */
export const startLoadBalancerCertSyncLoop = (
	intervalHours = 6,
): NodeJS.Timeout => {
	const tick = async () => {
		try {
			const allocs = await nomad<Alloc[]>(
				`/job/${TRAEFIK_HA_JOB_NAME}/allocations`,
			).catch(() => [] as Alloc[]);
			if (!allocs.some((a) => a.DesiredStatus === "run")) return;
			await syncTraefikCertsToConsulKV();
		} catch (e) {
			console.error("loadbalancer-certs: resync error:", e);
		}
	};
	// Deploy already syncs; first auto-resync happens after the interval.
	return setInterval(tick, intervalHours * 3600 * 1000);
};

export const startLoadBalancerMetricsSampler = (
	intervalSeconds = 60,
): NodeJS.Timeout => {
	const tick = async () => {
		try {
			await sampleLoadBalancerMetrics();
		} catch (e) {
			console.error("loadbalancer-metrics: sampler error:", e);
		}
	};
	void tick();
	return setInterval(tick, intervalSeconds * 1000);
};

// ---------------------------------------------------------------------------
// Background health-prune loop
// ---------------------------------------------------------------------------

export const startLoadBalancerDnsLoop = (
	intervalSeconds = 30,
): NodeJS.Timeout => {
	const tick = async () => {
		try {
			const enabled = await db.query.loadBalancer.findMany({
				where: eq(loadBalancer.enabled, true),
			});
			for (const lb of enabled) {
				try {
					await reconcileLoadBalancerDns(lb.organizationId);
				} catch (e) {
					console.error(
						`loadbalancer-dns: reconcile failed for org ${lb.organizationId}:`,
						e,
					);
				}
			}
		} catch (e) {
			console.error("loadbalancer-dns: loop error:", e);
		}
	};
	void tick();
	return setInterval(tick, intervalSeconds * 1000);
};
