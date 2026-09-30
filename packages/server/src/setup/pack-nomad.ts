// Shared low-level Nomad access for patching deployed Nomad-Pack jobs. A pack's
// jobs are named after the pack (not the appName), so they're found by the
// `pack.deployment_name == appName` meta stamped by `nomad-pack run`. Both
// pack-domains (Traefik tags) and pack-scaling (count/resources/autoscaling)
// patch the SAME deployed jobs, so the fetch/post/find helpers live here.

// Nomad reads/writes always go to the control plane (not a resource's serverId).
const NOMAD = (process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646").replace(
	/\/$/,
	"",
);
const nomadHeaders = (): Record<string, string> => {
	const token = process.env.NOMAD_TOKEN || "";
	return token ? { "X-Nomad-Token": token } : {};
};

export const nomadFetch = async <T>(path: string): Promise<T> => {
	const res = await fetch(`${NOMAD}/v1${path}`, { headers: nomadHeaders() });
	if (!res.ok) throw new Error(`Nomad ${res.status} on ${path}`);
	return res.json() as Promise<T>;
};

export const nomadPost = async (path: string, body: unknown): Promise<void> => {
	const res = await fetch(`${NOMAD}/v1${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...nomadHeaders() },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(
			`Nomad POST ${res.status} on ${path}: ${await res.text().catch(() => "")}`,
		);
	}
};

// Free-form Nomad job JSON we read and patch in place.
export type NomadJob = any;

/** The Nomad job IDs a pack deployment registered (matched by deployment_name). */
export const getPackJobIds = async (appName: string): Promise<string[]> => {
	let jobs: { ID: string; Meta?: Record<string, string> }[] = [];
	try {
		jobs = await nomadFetch("/jobs?meta=true");
	} catch {
		return [];
	}
	return jobs
		.filter((j) => j.Meta?.["pack.deployment_name"] === appName)
		.map((j) => j.ID);
};

/**
 * Fetch each of a pack deployment's jobs, run `mutate` on the job JSON in place,
 * and re-register (POST /jobs) any job the mutator reports as changed. Callers
 * that need to apply several patches (domains + scaling) should compose them into
 * ONE mutator so the job is re-registered once — a second POST would trigger an
 * extra reschedule.
 */
export const patchPackJobs = async (
	appName: string,
	mutate: (job: NomadJob) => boolean,
): Promise<void> => {
	const ids = await getPackJobIds(appName);
	for (const id of ids) {
		let job: NomadJob;
		try {
			job = await nomadFetch(`/job/${encodeURIComponent(id)}`);
		} catch {
			continue;
		}
		let changed = false;
		try {
			changed = mutate(job);
		} catch (e) {
			console.error(`patchPackJobs: mutate ${id} failed:`, e);
			continue;
		}
		if (changed) {
			await nomadPost("/jobs", { Job: job }).catch((e) =>
				console.error(`patchPackJobs: re-register ${id} failed:`, e),
			);
		}
	}
};
