import { Resolver } from "node:dns/promises";
import * as tls from "node:tls";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { domains, notifications } from "../../db/schema";
import {
	type ClusterAlertPayload,
	sendClusterAlertNotifications,
} from "../../utils/notifications/cluster-alert";
import { allServers, readCluster } from "../nomad-mesh";

// Root filesystem usage (%) at/above which a node is flagged for disk pressure.
const DISK_PERCENT_THRESHOLD = 85;
// Consecutive ticks of blocked evaluations before alerting (ignores the transient
// blocks that are normal while the autoscaler is bringing capacity up).
const BLOCKED_EVAL_TICKS = 2;
// Warn when a TLS certificate has fewer than this many days left.
const CERT_EXPIRY_WARN_DAYS = 14;
// Certs change at most daily, so probe them far less often than the main loop.
const CERT_CHECK_INTERVAL_MS = 30 * 60 * 1000;

// Days until the TLS cert served at host:443 expires; null if unreachable / no
// cert (a reachability problem, not a cert-expiry one — we don't alert on null).
const certDaysLeft = (host: string): Promise<number | null> =>
	new Promise((resolve) => {
		let done = false;
		const finish = (v: number | null) => {
			if (done) return;
			done = true;
			resolve(v);
		};
		try {
			const socket = tls.connect(
				{
					host,
					port: 443,
					servername: host,
					timeout: 5000,
					rejectUnauthorized: false,
				},
				() => {
					const cert = socket.getPeerCertificate();
					socket.end();
					if (!cert?.valid_to) return finish(null);
					const ms = new Date(cert.valid_to).getTime() - Date.now();
					finish(Math.floor(ms / 86_400_000));
				},
			);
			socket.on("error", () => finish(null));
			socket.on("timeout", () => {
				socket.destroy();
				finish(null);
			});
		} catch {
			finish(null);
		}
	});

/**
 * Cluster health monitor. On an interval it evaluates high-signal cluster
 * conditions — node reachability, raft leadership, cluster DNS resolvers,
 * sustained unplaceable allocations, per-node disk pressure, and TLS certificate
 * expiry — and, on a state TRANSITION, fires a cluster-alert notification to
 * every org that has the
 * clusterAlert channel enabled. State is per-subject and in-memory; the first
 * observation of a subject seeds silently (no alert), so it only alerts on real
 * changes, not on what was already broken at boot. Reuses the same channels as
 * the autoscaler's cluster alerts.
 */

const NOMAD_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const NOMAD_TOKEN = process.env.NOMAD_TOKEN || "";

const nomad = async (path: string) => {
	const res = await fetch(`${NOMAD_ADDRESS.replace(/\/$/, "")}/v1${path}`, {
		headers: NOMAD_TOKEN ? { "X-Nomad-Token": NOMAD_TOKEN } : {},
	});
	if (!res.ok) throw new Error(`Nomad ${res.status} on ${path}`);
	return res.json();
};

type Health = "ok" | "bad";
const state = new Map<string, Health>();
// Consecutive ticks with blocked evaluations (for the sustained-blocked check).
let blockedTicks = 0;
// When the cert-expiry probes last ran (they run every CERT_CHECK_INTERVAL_MS).
let lastCertCheck = 0;

// Distinct orgs with at least one clusterAlert-enabled notification channel.
const alertOrgs = async (): Promise<string[]> => {
	const rows = await db.query.notifications.findMany({
		where: eq(notifications.clusterAlert, true),
		columns: { organizationId: true },
	});
	return [...new Set(rows.map((r) => r.organizationId))];
};

const notifyAll = async (
	payload: Omit<ClusterAlertPayload, "Timestamp">,
): Promise<void> => {
	const orgs = await alertOrgs();
	const full: ClusterAlertPayload = {
		...payload,
		Timestamp: new Date().toISOString(),
	};
	for (const org of orgs) {
		await sendClusterAlertNotifications(org, full).catch(() => {});
	}
};

/**
 * Compare a subject's current health to its last-known and alert on transition.
 * First observation seeds silently (no alert for pre-existing conditions).
 */
const evaluate = async (
	key: string,
	ok: boolean,
	opts: {
		downType: "warning" | "critical";
		downTitle: string;
		downMessage: string;
		upTitle: string;
		upMessage: string;
	},
): Promise<void> => {
	const status: Health = ok ? "ok" : "bad";
	const prev = state.get(key);
	state.set(key, status);
	if (prev === undefined || prev === status) return;
	if (status === "bad") {
		await notifyAll({
			EventType: opts.downType,
			Title: opts.downTitle,
			Message: opts.downMessage,
		});
	} else {
		await notifyAll({
			EventType: "recovered",
			Title: opts.upTitle,
			Message: opts.upMessage,
		});
	}
};

export const checkClusterHealth = async (): Promise<void> => {
	// 1) Node reachability — alert when a node drops to down/disconnected.
	const nodes = (await nomad("/nodes")) as {
		ID: string;
		Name: string;
		Status: string;
	}[];
	for (const n of nodes) {
		const ok = n.Status === "ready" || n.Status === "initializing";
		await evaluate(`node:${n.Name}`, ok, {
			downType: "critical",
			downTitle: `Node ${n.Name} is ${n.Status}`,
			downMessage: `Nomad node ${n.Name} left the ready state (status: ${n.Status}). Allocations on it may be rescheduled.`,
			upTitle: `Node ${n.Name} recovered`,
			upMessage: `Nomad node ${n.Name} is ready again.`,
		});
	}

	// 2) Raft leadership — no leader means the control plane can't schedule.
	let hasLeader = false;
	try {
		const leader = (await nomad("/status/leader")) as string;
		hasLeader = !!leader && leader.length > 0;
	} catch {
		hasLeader = false;
	}
	await evaluate("raft:leader", hasLeader, {
		downType: "critical",
		downTitle: "Raft has no leader",
		downMessage:
			"The Nomad servers have no elected leader — scheduling is stalled until quorum is restored.",
		upTitle: "Raft leader restored",
		upMessage: "A Nomad server leader was elected; scheduling has resumed.",
	});

	// 3) Cluster DNS — each server runs a dnsmasq resolving *.service.consul.
	try {
		const cluster = readCluster();
		for (const s of cluster ? allServers(cluster) : []) {
			let ok = false;
			try {
				const r = new Resolver({ timeout: 2000, tries: 1 });
				r.setServers([s.wgIp]);
				ok = (await r.resolve4("consul.service.consul")).length > 0;
			} catch {
				ok = false;
			}
			await evaluate(`dns:${s.name}`, ok, {
				downType: "warning",
				downTitle: `Cluster DNS down on ${s.name}`,
				downMessage: `The resolver on ${s.name} (${s.wgIp}) stopped answering *.service.consul; workloads using it may fail name resolution.`,
				upTitle: `Cluster DNS recovered on ${s.name}`,
				upMessage: `The resolver on ${s.name} is answering again.`,
			});
		}
	} catch {}

	// 4) Unplaceable allocations — sustained blocked evaluations (transient blocks
	//    during normal scaling are ignored via the consecutive-tick threshold).
	try {
		const evals = (await nomad("/evaluations")) as { Status: string }[];
		const blocked = evals.filter((e) => e.Status === "blocked").length;
		blockedTicks = blocked > 0 ? blockedTicks + 1 : 0;
		await evaluate("scheduling:blocked", blockedTicks < BLOCKED_EVAL_TICKS, {
			downType: "warning",
			downTitle: "Allocations can't be placed",
			downMessage: `${blocked} evaluation(s) have been blocked for a while — the cluster can't place some allocations (out of capacity or unsatisfiable constraints). Add capacity or check the job.`,
			upTitle: "Scheduling recovered",
			upMessage: "Blocked evaluations cleared; allocations are placing again.",
		});
	} catch {}

	// 5) Disk pressure — root filesystem usage per ready node.
	for (const n of nodes) {
		if (n.Status !== "ready") continue;
		try {
			const stats = (await nomad(`/client/stats?node_id=${n.ID}`)) as {
				DiskStats?: { Mountpoint: string; UsedPercent: number }[];
			};
			const root = (stats.DiskStats || []).find((d) => d.Mountpoint === "/");
			const pct = Math.round(root?.UsedPercent ?? 0);
			await evaluate(
				`disk:${n.Name}`,
				!root || root.UsedPercent < DISK_PERCENT_THRESHOLD,
				{
					downType: "warning",
					downTitle: `Disk pressure on ${n.Name}`,
					downMessage: `Root filesystem on ${n.Name} is ${pct}% full (≥ ${DISK_PERCENT_THRESHOLD}%). Free space soon or the node may stop accepting work.`,
					upTitle: `Disk pressure cleared on ${n.Name}`,
					upMessage: `Root filesystem on ${n.Name} is back under ${DISK_PERCENT_THRESHOLD}%.`,
				},
			);
		} catch {}
	}

	// 6) TLS certificate expiry — probe each HTTPS domain's cert (throttled, since
	//    certs change at most daily). null (unreachable) is skipped, not alerted.
	if (Date.now() - lastCertCheck >= CERT_CHECK_INTERVAL_MS) {
		lastCertCheck = Date.now();
		try {
			const rows = await db.query.domains.findMany({
				where: eq(domains.https, true),
				columns: { host: true },
			});
			const hosts = [...new Set(rows.map((r) => r.host).filter(Boolean))];
			for (const host of hosts) {
				const days = await certDaysLeft(host);
				if (days === null) continue;
				await evaluate(`cert:${host}`, days >= CERT_EXPIRY_WARN_DAYS, {
					downType: days < 3 ? "critical" : "warning",
					downTitle: `TLS certificate expiring for ${host}`,
					downMessage: `The TLS certificate for ${host} expires in ${days} day(s). Check that Let's Encrypt renewal is working (Traefik).`,
					upTitle: `TLS certificate renewed for ${host}`,
					upMessage: `The certificate for ${host} is valid for ${days} more days.`,
				});
			}
		} catch {}
	}
};

export const startClusterHealthLoop = (
	intervalSeconds = 60,
): NodeJS.Timeout => {
	// Seed immediately (silent), then evaluate on the interval.
	checkClusterHealth().catch((e) => console.error("[cluster-health]", e));
	return setInterval(() => {
		checkClusterHealth().catch((e) => console.error("[cluster-health]", e));
	}, intervalSeconds * 1000);
};
