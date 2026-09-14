import { eq } from "drizzle-orm";
import { db } from "../../db";
import { notifications } from "../../db/schema";
import {
	type ClusterAlertPayload,
	sendClusterAlertNotifications,
} from "../../utils/notifications/cluster-alert";

/**
 * Cluster health monitor. On an interval it evaluates a small set of high-signal
 * cluster conditions (node reachability, raft leadership) and — on a state
 * TRANSITION — fires a cluster-alert notification to every org that has the
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
	const nodes = (await nomad("/nodes")) as { Name: string; Status: string }[];
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
