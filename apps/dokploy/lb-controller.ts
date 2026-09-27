/**
 * HA LoadBalancer DNS controller.
 *
 * Runs as a Nomad `system` job on every server node (see setup/lb-controller-job.ts),
 * so it survives the hub going down — the reason the panel-side loop (single panel
 * on the hub) is a SPOF. Only the Consul-lock holder reconciles.
 *
 * It is deliberately dependency-light: it needs ONLY Consul (local agent on the
 * node) — no Postgres (which is hub-only) and no Nomad. The panel publishes the LB
 * config (hostname, zone, Cloudflare token, ttl, enabled, member IPs) to Consul KV
 * at `nomploy/lb/config`; the controller reads that, TCP-health-probes each member's
 * public :443, and keeps the hostname's Cloudflare A records equal to the healthy
 * members. Because health is a direct network probe (not Nomad alloc state), a
 * controller on a surviving worker correctly prunes a dead hub from DNS.
 */
import net from "node:net";

const CONSUL = process.env.CONSUL_HTTP_ADDR || "http://127.0.0.1:8500";
const CONSUL_TOKEN = process.env.CONSUL_TOKEN || "";
const CF_API = "https://api.cloudflare.com/client/v4";
const KV_CONFIG = "nomploy/lb/config";
const KV_LEADER = "nomploy/lb/leader";
const INTERVAL_MS = 30_000;
const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 4000;

const consulHeaders = (): Record<string, string> =>
	CONSUL_TOKEN ? { "X-Consul-Token": CONSUL_TOKEN } : {};

type LbConfig = {
	hostname: string;
	zoneName: string;
	cfToken: string;
	ttl: number;
	enabled: boolean;
	members: { name: string; publicIp: string }[];
};

// --- Consul session + leader lock ---------------------------------------------

let sessionId: string | null = null;

const createSession = async (): Promise<string | null> => {
	try {
		const res = await fetch(`${CONSUL}/v1/session/create`, {
			method: "PUT",
			headers: consulHeaders(),
			// TTL session auto-expires if this node dies, releasing the lock.
			body: JSON.stringify({ TTL: "30s", Behavior: "delete", LockDelay: "5s" }),
		});
		if (!res.ok) return null;
		return ((await res.json()) as { ID: string }).ID;
	} catch {
		return null;
	}
};

const renewSession = async (id: string): Promise<boolean> => {
	try {
		const res = await fetch(`${CONSUL}/v1/session/renew/${id}`, {
			method: "PUT",
			headers: consulHeaders(),
		});
		return res.ok;
	} catch {
		return false;
	}
};

const acquireLock = async (id: string): Promise<boolean> => {
	try {
		const res = await fetch(`${CONSUL}/v1/kv/${KV_LEADER}?acquire=${id}`, {
			method: "PUT",
			headers: consulHeaders(),
			body: process.env.NOMAD_ALLOC_ID || "controller",
		});
		if (!res.ok) return false;
		return (await res.json()) === true;
	} catch {
		return false;
	}
};

// --- Config + health ----------------------------------------------------------

const readConfig = async (): Promise<LbConfig | null> => {
	try {
		const res = await fetch(`${CONSUL}/v1/kv/${KV_CONFIG}?raw=true`, {
			headers: consulHeaders(),
		});
		if (!res.ok) return null;
		return (await res.json()) as LbConfig;
	} catch {
		return null;
	}
};

const probe = (ip: string): Promise<boolean> =>
	new Promise((resolve) => {
		const sock = net.connect({ host: ip, port: PROBE_PORT });
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(PROBE_TIMEOUT_MS);
		sock.once("connect", () => done(true));
		sock.once("timeout", () => done(false));
		sock.once("error", () => done(false));
	});

// --- Cloudflare ---------------------------------------------------------------

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
	const data = (await res.json()) as {
		success: boolean;
		result: T;
		errors?: { message: string }[];
	};
	if (!res.ok || !data.success) {
		throw new Error(data.errors?.[0]?.message || `Cloudflare ${res.status}`);
	}
	return data.result;
};

const reconcile = async (cfg: LbConfig): Promise<void> => {
	if (!cfg.enabled || !cfg.hostname || !cfg.cfToken) return;
	// Health-probe members; desired = reachable public IPs.
	const results = await Promise.all(
		cfg.members.map(async (m) => ({
			ip: m.publicIp,
			ok: await probe(m.publicIp),
		})),
	);
	const desired = [
		...new Set(results.filter((r) => r.ok && r.ip).map((r) => r.ip)),
	].sort();

	const zones = await cf<{ id: string; name: string }[]>(
		cfg.cfToken,
		`/zones?name=${encodeURIComponent(cfg.zoneName)}`,
	);
	const zoneId = zones.find((z) => z.name === cfg.zoneName)?.id ?? zones[0]?.id;
	if (!zoneId) return;

	const existing = await cf<{ id: string; content: string }[]>(
		cfg.cfToken,
		`/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(cfg.hostname)}&per_page=100`,
	);
	const existingIps = new Set(existing.map((r) => r.content));
	const desiredSet = new Set(desired);

	for (const ip of desired) {
		if (existingIps.has(ip)) continue;
		await cf(cfg.cfToken, `/zones/${zoneId}/dns_records`, {
			method: "POST",
			body: JSON.stringify({
				type: "A",
				name: cfg.hostname,
				content: ip,
				ttl: cfg.ttl,
				proxied: false,
			}),
		});
		console.log(`lb-controller: +A ${cfg.hostname} ${ip}`);
	}
	for (const r of existing) {
		if (desiredSet.has(r.content)) continue;
		await cf(cfg.cfToken, `/zones/${zoneId}/dns_records/${r.id}`, {
			method: "DELETE",
		});
		console.log(`lb-controller: -A ${cfg.hostname} ${r.content}`);
	}
};

// --- Loop ---------------------------------------------------------------------

const tick = async () => {
	try {
		if (!sessionId) sessionId = await createSession();
		if (!sessionId) return;
		if (!(await renewSession(sessionId))) {
			sessionId = null;
			return;
		}
		const isLeader = await acquireLock(sessionId);
		if (!isLeader) return; // another node holds the lock
		const cfg = await readConfig();
		if (cfg) await reconcile(cfg);
	} catch (e) {
		console.error("lb-controller: tick error:", e);
	}
};

console.log("lb-controller: starting (Consul-lock HA DNS controller)");
await tick();
setInterval(tick, INTERVAL_MS);
