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
 * Health-aware: it reads the job's Nomad DEPLOYMENT status (successful/failed) —
 * the same signal the old blocking `nomad job run` reacted to — and only falls back
 * to allocation ClientStatus for jobs that have no deployment (no `update` stanza).
 */

// Python probe: resolve the job id(s), then poll the job's deployment status until
// terminal or the deadline. Lives inside a JS template literal, so it must contain
// no `${` and no backticks — uses %-formatting only.
//   argv: <name> <mode: job|pack> <deadlineSec>
//   exit 0 = healthy OR still-pending-at-deadline (optimistic, matches the dashboard)
//   exit 1 = a deployment failed / allocations are definitively failed-or-lost
const ROLLOUT_PROBE_PY = `import json, subprocess, sys, time
name, mode, deadline_s = sys.argv[1], sys.argv[2], int(sys.argv[3])
deadline = time.time() + deadline_s
def api(path):
    try:
        out = subprocess.run(["nomad","operator","api",path], capture_output=True, text=True, timeout=15)
        return json.loads(out.stdout or "null") if out.returncode == 0 else None
    except Exception:
        return None
def job_ids():
    if mode == "job":
        return [name]
    jobs = api("/v1/jobs?meta=true") or []
    return [j["ID"] for j in jobs if (j.get("Meta") or {}).get("pack.deployment_name") == name]
# Resolve the deployed job id(s); packs appear a few seconds after registration.
ids = []
while time.time() < deadline:
    ids = job_ids()
    if ids:
        break
    time.sleep(3)
if not ids:
    print("Could not resolve deployed job(s) to monitor; skipping health check")
    sys.exit(0)
def alloc_status(jid):
    allocs = api("/v1/job/%s/allocations" % jid) or []
    if not allocs:
        job = api("/v1/job/%s" % jid) or {}
        return "dead" if job.get("Status") == "dead" else "pending"
    latest = max((a.get("JobVersion", 0) for a in allocs), default=0)
    cur = [a for a in allocs if a.get("JobVersion", 0) == latest]
    if any(a.get("ClientStatus") == "running" for a in cur):
        return "running"
    if cur and all(a.get("ClientStatus") in ("failed", "lost") for a in cur):
        return "failed"
    return "pending"
def deploy_status(jid):
    # Prefer the deployment status (health-check aware). Jobs with no update{}
    # stanza have no deployment -> fall back to allocation ClientStatus.
    dep = api("/v1/job/%s/deployment" % jid)
    st = (dep or {}).get("Status") if isinstance(dep, dict) else None
    if st == "successful":
        return "ok"
    if st in ("failed", "cancelled"):
        return "failed"
    if st in ("running", "pending", "paused", "blocked", "initializing"):
        return "pending"
    # No deployment for this job — judge by its allocations.
    a = alloc_status(jid)
    if a == "running":
        return "ok"
    if a in ("failed", "dead"):
        return "failed"
    return "pending"
while time.time() < deadline:
    sts = {jid: deploy_status(jid) for jid in ids}
    bad = [k for k, v in sts.items() if v == "failed"]
    if bad:
        print("Rollout FAILED for: %s" % ", ".join(bad))
        sys.exit(1)
    if all(v == "ok" for v in sts.values()):
        print("Rollout healthy \\u2705")
        sys.exit(0)
    time.sleep(4)
print("Rollout not confirmed healthy within the window (still in progress) - check the dashboard")
sys.exit(0)
`;

// Default off-queue monitor window. Longer than the old inline 150s probe since it
// no longer blocks the queue; bounded so a never-healthy rollout still resolves.
const DEFAULT_DEADLINE_SEC = 300;

// Shell that runs the probe and appends its output to the deployment log. Guarded on
// python3 so a host without it degrades to "skip + assume ok" rather than hanging.
const rolloutProbeShell = (
	name: string,
	mode: "job" | "pack",
	deadlineSec: number,
	logPath: string,
): string =>
	`{ if command -v python3 >/dev/null 2>&1; then echo "Monitoring rollout…"; echo "${encodeBase64(
		ROLLOUT_PROBE_PY,
	)}" | base64 -d | python3 - "${name}" "${mode}" "${deadlineSec}"; else echo "Skipping rollout monitor (python3 unavailable)"; fi; } >> ${logPath} 2>&1`;

export interface RolloutMonitorOptions {
	appName: string;
	mode: "job" | "pack";
	serverId?: string | null;
	logPath: string;
	deadlineSec?: number;
	/** Finalize a healthy rollout (status "done" + success notification). */
	onSuccess: () => Promise<void>;
	/** Finalize a failed rollout (status "error" + error notification). */
	onFailure: (reason: string) => Promise<void>;
}

/**
 * Fire-and-forget: watch a detached rollout to a terminal state, append the result to
 * the deployment log, then run the caller's finalizer. NEVER throws (it is not
 * awaited by the deploy worker) — any internal error finalizes as a failure so the
 * deployment never hangs in "running".
 */
export const monitorNomadRollout = (opts: RolloutMonitorOptions): void => {
	void (async () => {
		const deadlineSec = opts.deadlineSec ?? DEFAULT_DEADLINE_SEC;
		const cmd = rolloutProbeShell(
			opts.appName,
			opts.mode,
			deadlineSec,
			opts.logPath,
		);
		let healthy = true;
		try {
			if (opts.serverId) {
				await execAsyncRemote(opts.serverId, cmd);
			} else {
				await execAsync(cmd);
			}
		} catch {
			// Probe exited non-zero (exit 1) => definitive rollout failure.
			healthy = false;
		}
		try {
			if (healthy) {
				await opts.onSuccess();
			} else {
				await opts.onFailure("Rollout did not become healthy");
			}
		} catch (err) {
			console.error(
				`[deploy-monitor] finalizer failed for ${opts.appName}:`,
				err,
			);
		}
	})();
};
