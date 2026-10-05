// Shared low-level Nomad access for patching deployed Nomad-Pack jobs. A pack's
// jobs are named after the pack (not the appName), so they're found by the
// `pack.deployment_name == appName` meta stamped by `nomad-pack run`. Both
// pack-domains (Traefik tags) and pack-scaling (count/resources/autoscaling)
// patch the SAME deployed jobs, so the fetch/post/find helpers live here.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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

export const nomadPut = async (path: string, body: unknown): Promise<void> => {
	const res = await fetch(`${NOMAD}/v1${path}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json", ...nomadHeaders() },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(
			`Nomad PUT ${res.status} on ${path}: ${await res.text().catch(() => "")}`,
		);
	}
};

/** DELETE a path (e.g. a Nomad Variable); a 404 is treated as success. */
export const nomadDelete = async (path: string): Promise<void> => {
	const res = await fetch(`${NOMAD}/v1${path}`, {
		method: "DELETE",
		headers: nomadHeaders(),
	});
	if (!res.ok && res.status !== 404) {
		throw new Error(`Nomad DELETE ${res.status} on ${path}`);
	}
};

/** Parse a job's HCL into canonical JSON via Nomad's /v1/jobs/parse. */
export const nomadParseHCL = async (hcl: string): Promise<NomadJob> => {
	const res = await fetch(`${NOMAD}/v1/jobs/parse`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...nomadHeaders() },
		body: JSON.stringify({ JobHCL: hcl, Canonicalize: true }),
	});
	if (!res.ok) {
		throw new Error(
			`Nomad POST ${res.status} on /jobs/parse: ${await res.text().catch(() => "")}`,
		);
	}
	return res.json() as Promise<NomadJob>;
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

/** The pack.* meta `nomad-pack run` stamps — re-stamped on a direct register so
 * `nomad-pack destroy` and getPackJobIds still find the jobs. */
export interface PackMetaCtx {
	deploymentName: string; // pack.deployment_name (== appName)
	packName: string; // pack.name
	registryName: string; // pack.registry (e.g. "nomploy-custom" / "default")
	version: string; // pack.version (the pinned ref, or "latest")
}

/** Recursively collect *.nomad files under a render output dir. */
const findNomadFiles = async (dir: string): Promise<string[]> => {
	const out: string[] = [];
	// Infer the Dirent[] element type from the call (annotating with
	// Awaited<ReturnType<typeof readdir>> picks the Buffer overload → TS error).
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
	if (!entries) return out;
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...(await findNomadFiles(p)));
		else if (e.name.endsWith(".nomad")) out.push(p);
	}
	return out;
};

/**
 * Deploy a Nomad-Pack in a SINGLE registration: read the pack's rendered job
 * files (written by `nomad-pack render --to-dir`), parse each to JSON, re-stamp
 * the pack.* meta `nomad-pack run` would add (so `nomad-pack destroy` and
 * getPackJobIds still find them), run `patch` on the job (ingress tags, scaling,
 * canary_tags, shutdown_delay …), and register it. Returns the job IDs.
 *
 * Replaces `nomad-pack run` + a post-deploy re-patch, which was TWO registrations
 * per deploy — fatal to canary: each registration is its own canary transition,
 * and consulCatalog drops a service with no passing instance during the churn →
 * a 404 window. One registration = one clean canary.
 */
export const registerRenderedPackJobs = async (
	renderDir: string,
	meta: PackMetaCtx,
	patch: (job: NomadJob) => void,
): Promise<string[]> => {
	const files = await findNomadFiles(renderDir);
	const ids: string[] = [];
	for (const file of files) {
		const hcl = await readFile(file, "utf8");
		if (!hcl.trim()) continue;
		const parsed = await nomadParseHCL(hcl);
		if (!parsed || !parsed.ID) continue;
		parsed.Meta = {
			...(parsed.Meta ?? {}),
			"pack.deployment_name": meta.deploymentName,
			"pack.name": meta.packName,
			"pack.job": parsed.ID,
			"pack.registry": meta.registryName,
			"pack.version": meta.version,
		};
		try {
			patch(parsed);
		} catch (e) {
			console.error(`registerRenderedPackJobs: patch ${parsed.ID} failed:`, e);
		}
		await nomadPost("/jobs", { Job: parsed });
		ids.push(parsed.ID);
	}
	return ids;
};
