import postgres from "postgres";
import { dbUrl } from "../db/constants";

/**
 * Control-plane leader election via a Postgres SESSION-LEVEL ADVISORY LOCK.
 *
 * IMPORTANT: an advisory lock touches NO tables, schema, or data — it is an
 * in-memory flag keyed by an integer, held for the life of ONE connection and
 * auto-released the instant that connection closes (so a dead/replaced panel
 * frees leadership on its own). We keep a dedicated single connection open for
 * the process lifetime to hold it.
 *
 * Why: the panel runs background singletons (autoscaler, cluster-health monitor,
 * scheduled scaling, cron backups/schedules) that must run on exactly ONE
 * instance. With count=1 there is only ever one panel, so this is a no-op today;
 * it's the prerequisite for zero-downtime rolling updates, where a new (canary)
 * panel briefly overlaps the old one — only the lock holder runs the loops, the
 * other just serves HTTP until it inherits the lock.
 */

// Arbitrary fixed key identifying "the nomploy control-plane leader".
const LEADER_LOCK_KEY = 480_2147;

let leaderClient: ReturnType<typeof postgres> | null = null;

/**
 * Attempt to become leader. Returns true if this instance holds (or just
 * acquired) the advisory lock. Non-blocking: pg_try_advisory_lock returns
 * immediately whether or not the lock was free.
 */
export const tryAcquireLeadership = async (): Promise<boolean> => {
	if (leaderClient) return true; // already leader
	// Dedicated, never-idle-closed connection: the lock lives as long as it does.
	const client = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		max_lifetime: 0,
		connection: { application_name: "nomploy-leader" },
	});
	try {
		const rows = await client<{ locked: boolean }[]>`
			SELECT pg_try_advisory_lock(${LEADER_LOCK_KEY}) AS locked
		`;
		if (rows[0]?.locked) {
			leaderClient = client; // keep it open → keep the lock
			return true;
		}
		await client.end({ timeout: 5 });
		return false;
	} catch {
		await client.end({ timeout: 5 }).catch(() => {});
		return false;
	}
};

/**
 * Run `start` once this instance is the leader. Runs immediately if the lock is
 * free; otherwise polls every `intervalMs` until it's acquired (i.e. the previous
 * leader exited and released it), then runs `start` exactly once.
 */
export const runAsLeader = async (
	start: () => void | Promise<void>,
	opts: { intervalMs?: number; onWait?: () => void } = {},
): Promise<void> => {
	const intervalMs = opts.intervalMs ?? 15_000;
	if (await tryAcquireLeadership()) {
		await start();
		return;
	}
	opts.onWait?.();
	const timer = setInterval(async () => {
		if (await tryAcquireLeadership()) {
			clearInterval(timer);
			await start();
		}
	}, intervalMs);
	// Don't keep the event loop alive just for the poll.
	timer.unref?.();
};

/** True if this instance currently holds control-plane leadership. */
export const isLeader = (): boolean => leaderClient !== null;
