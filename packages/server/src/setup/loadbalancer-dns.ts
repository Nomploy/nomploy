import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { dnsProvider, loadBalancer, server } from "../db/schema";
import { TRAEFIK_HA_JOB_NAME } from "./traefik-ha";

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
	ip: string | null;
	wgIp: string | null;
};

type Alloc = {
	NodeName: string;
	NodeID: string;
	ClientStatus: string;
	DesiredStatus: string;
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

	// De-dup by node (system job = one alloc per node, but be defensive).
	const seen = new Set<string>();
	const out: LbNode[] = [];
	for (const a of live) {
		if (seen.has(a.NodeName)) continue;
		seen.add(a.NodeName);
		const derivedWg = wgByNode.get(a.NodeName) ?? null;
		const s =
			(derivedWg ? byWg.get(derivedWg) : undefined) ?? byName.get(a.NodeName);
		out.push({
			node: a.NodeName,
			status: a.ClientStatus,
			healthy: a.ClientStatus === "running",
			ip: s?.ipAddress ?? null,
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
			nodes.filter((n) => n.healthy && n.ip).map((n) => n.ip as string),
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

const scrapeNode = async (
	n: LbNode,
	inDns: boolean,
): Promise<LbNodeMetrics> => {
	const host = n.wgIp || n.ip;
	const base: LbNodeMetrics = {
		node: n.node,
		ip: n.ip,
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
	try {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), 4000);
		const res = await fetch(`http://${host}:${METRICS_PORT}/metrics`, {
			signal: ctl.signal,
		});
		clearTimeout(t);
		if (!res.ok) return base;
		const body = await res.text();
		const total = sumMetric(body, "traefik_entrypoint_requests_total");
		const classes = sumByCodeClass(body);
		const durSum = sumMetric(
			body,
			"traefik_entrypoint_request_duration_seconds_sum",
		);
		const durCount = sumMetric(
			body,
			"traefik_entrypoint_request_duration_seconds_count",
		);

		// Request rate from the delta since the previous poll for this node.
		const now = Date.now();
		const prev = lastSample.get(n.node);
		let reqPerSec = 0;
		if (prev && now > prev.ts && total >= prev.total) {
			reqPerSec = (total - prev.total) / ((now - prev.ts) / 1000);
		}
		lastSample.set(n.node, { ts: now, total });

		return {
			...base,
			reachable: true,
			requests: total,
			req2xx: classes["2"] ?? 0,
			req4xx: classes["4"] ?? 0,
			req5xx: classes["5"] ?? 0,
			avgLatencyMs: durCount > 0 ? (durSum / durCount) * 1000 : 0,
			reqPerSec,
		};
	} catch {
		return base;
	}
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
		nodes.map((n) => scrapeNode(n, !!(n.ip && inDnsIps.has(n.ip)))),
	);
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
