import { nomadFetch } from "@nomploy/server/setup/pack-nomad";
import { encodeBase64 } from "@nomploy/server/utils/docker/utils";
import {
	execAsync,
	execAsyncRemote,
} from "@nomploy/server/utils/process/execAsync";

/**
 * Async rollout monitoring for detached Nomad deploys.
 *
 * The deploy worker registers the job with `nomad job run -detach` (returns at
 * registration) so a slow or stuck rollout no longer blocks the single-concurrency
 * deployment queue. This module watches the rollout OFF the queue and finalizes the
 * deployment (status + notification) once Nomad reaches a terminal state.
 *
 * Reads go over Nomad's HTTP API via nomadFetch (the panel's control-plane client —
 * see [[nomploy-nomad-reads-control-plane]]), NOT the `nomad` CLI: the CLI isn't
 * reliably reachable from inside the panel container, whereas nomadFetch is the same
 * client pack-domains / pack-scaling already use. Health-aware: it reads the job's
 * DEPLOYMENT status (successful/failed) — the signal the old blocking `nomad job run`
 * reacted to — and falls back to allocation ClientStatus for jobs with no `update`
 * stanza (hence no deployment).
 */

const DEFAULT_DEADLINE_MS = 300_000;
const POLL_INTERVAL_MS = 4000;

type RolloutState = "ok" | "failed" | "pending";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolve the deployed Nomad job id(s). "job" mode registers job id == appName;
// "pack" mode's jobs are named after the pack and found via the deployment_name meta
// nomad-pack stamps (they appear a few seconds after registration).
const resolveJobIds = async (
	appName: string,
	mode: "job" | "pack",
	deadline: number,
): Promise<string[]> => {
	if (mode === "job") return [appName];
	while (Date.now() < deadline) {
		try {
			const jobs =
				await nomadFetch<{ ID: string; Meta?: Record<string, string> }[]>(
					"/jobs?meta=true",
				);
			const ids = jobs
				.filter((j) => (j.Meta || {})["pack.deployment_name"] === appName)
				.map((j) => j.ID);
			if (ids.length) return ids;
		} catch {
			// transient — retry until the deadline
		}
		await sleep(3000);
	}
	return [];
};

const jobState = async (jid: string): Promise<RolloutState> => {
	const p = encodeURIComponent(jid);
	// Prefer the deployment status (health-check aware).
	try {
		const dep = await nomadFetch<{ Status?: string }>(`/job/${p}/deployment`);
		const st = dep?.Status;
		if (st === "successful") return "ok";
		if (st === "failed" || st === "cancelled") return "failed";
		if (st) return "pending"; // running / paused / blocked / pending
	} catch {
		// 404 => the job has no deployment (no `update` stanza). Judge by allocs.
	}
	try {
		const allocs = await nomadFetch<
			{ ClientStatus?: string; JobVersion?: number }[]
		>(`/job/${p}/allocations`);
		if (!allocs?.length) {
			const job = await nomadFetch<{ Status?: string }>(`/job/${p}`).catch(
				() => ({}) as { Status?: string },
			);
			return job?.Status === "dead" ? "failed" : "pending";
		}
		const latest = Math.max(...allocs.map((a) => a.JobVersion ?? 0));
		const cur = allocs.filter((a) => (a.JobVersion ?? 0) === latest);
		if (cur.some((a) => a.ClientStatus === "running")) return "ok";
		if (
			cur.length &&
			cur.every((a) => a.ClientStatus === "failed" || a.ClientStatus === "lost")
		)
			return "failed";
		return "pending";
	} catch {
		return "pending";
	}
};

export interface RolloutMonitorOptions {
	appName: string;
	mode: "job" | "pack";
	serverId?: string | null;
	logPath: string;
	deadlineMs?: number;
	/** Finalize a healthy rollout (status "done" + success notification). */
	onSuccess: () => Promise<void>;
	/** Finalize a failed rollout (status "error" + error notification). */
	onFailure: (reason: string) => Promise<void>;
}

// Append a line to the deployment log (wherever the deploy wrote it: local for a
// control-plane deploy, remote for a serverId deploy). Best-effort.
const appendLog = async (
	opts: Pick<RolloutMonitorOptions, "serverId" | "logPath">,
	line: string,
): Promise<void> => {
	const cmd = `echo "${encodeBase64(`${line}\n`)}" | base64 -d >> ${opts.logPath}`;
	try {
		if (opts.serverId) await execAsyncRemote(opts.serverId, cmd);
		else await execAsync(cmd);
	} catch {
		// logging is best-effort; never let it affect finalization
	}
};

/**
 * Fire-and-forget: watch a detached rollout to a terminal state, append the result to
 * the deployment log, then run the caller's finalizer. NEVER throws (it is not
 * awaited by the deploy worker) — any internal error finalizes as success-pending so
 * a healthy deploy is never spuriously failed and the deployment never hangs
 * "running".
 */
export const monitorNomadRollout = (opts: RolloutMonitorOptions): void => {
	void (async () => {
		const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
		let outcome: RolloutState = "pending";
		try {
			await appendLog(opts, "Monitoring rollout…");
			const ids = await resolveJobIds(opts.appName, opts.mode, deadline);
			if (!ids.length) {
				await appendLog(
					opts,
					"Could not resolve deployed job(s) to monitor; skipping health check",
				);
				outcome = "ok";
			} else {
				while (Date.now() < deadline) {
					const states = await Promise.all(ids.map(jobState));
					if (states.some((s) => s === "failed")) {
						outcome = "failed";
						break;
					}
					if (states.every((s) => s === "ok")) {
						outcome = "ok";
						break;
					}
					await sleep(POLL_INTERVAL_MS);
				}
			}
		} catch (err) {
			// Unexpected monitor error: don't fail an otherwise-registered deploy.
			console.error(`[deploy-monitor] ${opts.appName}:`, err);
			outcome = "pending";
		}

		try {
			if (outcome === "failed") {
				await appendLog(opts, "Rollout FAILED ❌");
				await opts.onFailure("Rollout did not become healthy");
			} else {
				await appendLog(
					opts,
					outcome === "ok"
						? "Rollout healthy ✅"
						: "Rollout not confirmed within the window (still in progress) — check the dashboard",
				);
				await opts.onSuccess();
			}
		} catch (err) {
			console.error(
				`[deploy-monitor] finalizer failed for ${opts.appName}:`,
				err,
			);
		}
	})();
};
