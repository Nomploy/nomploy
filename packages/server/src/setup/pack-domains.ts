import type {
	compose as composeTable,
	domains as domainsTable,
} from "../db/schema";
import {
	applyDefaultCertResolver,
	getDefaultCertResolver,
} from "../services/cert-resolver";
import { generateConsulTags } from "../utils/builders/nomad";

type Compose = typeof composeTable.$inferSelect;
type Domain = typeof domainsTable.$inferSelect;

// Nomad reads/writes always go to the control plane (not a resource's serverId).
const NOMAD = (process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646").replace(
	/\/$/,
	"",
);
const nomadHeaders = (): Record<string, string> => {
	const token = process.env.NOMAD_TOKEN || "";
	return token ? { "X-Nomad-Token": token } : {};
};
const nomadFetch = async <T>(path: string): Promise<T> => {
	const res = await fetch(`${NOMAD}/v1${path}`, { headers: nomadHeaders() });
	if (!res.ok) throw new Error(`Nomad ${res.status} on ${path}`);
	return res.json() as Promise<T>;
};
const nomadPost = async (path: string, body: unknown): Promise<void> => {
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

// The port a Consul service is reachable on (its registered ServicePort).
const consulServicePort = async (name: string): Promise<number | null> => {
	try {
		const token = process.env.CONSUL_TOKEN || "";
		const res = await fetch(
			`http://127.0.0.1:8500/v1/catalog/service/${encodeURIComponent(name)}`,
			{ headers: token ? { "X-Consul-Token": token } : {} },
		);
		if (!res.ok) return null;
		const entries = (await res.json()) as { ServicePort?: number }[];
		return entries[0]?.ServicePort ?? null;
	} catch {
		return null;
	}
};

export type PackService = { name: string; port: number | null };

/**
 * The services a Nomad Pack deployment registers, with their reachable ports —
 * for the domain-config dropdown (pick which service a domain routes to). A
 * pack's jobs are named after the pack, not the appName, so we find them by the
 * `pack.deployment_name == appName` meta and read each job's service stanzas.
 */
export const loadPackServices = async (
	appName: string,
): Promise<PackService[]> => {
	let jobs: { ID: string; Meta?: Record<string, string> }[] = [];
	try {
		jobs = await nomadFetch("/jobs?meta=true");
	} catch {
		return [];
	}
	const ids = jobs
		.filter((j) => j.Meta?.["pack.deployment_name"] === appName)
		.map((j) => j.ID);

	type NomadPort = { Label?: string; Value?: number; To?: number };
	type NomadSvc = { Name?: string; PortLabel?: string };
	const jobPortByName = new Map<string, number>();
	const names = new Set<string>();
	for (const id of ids) {
		try {
			const job = await nomadFetch<{
				TaskGroups?: {
					Networks?: {
						DynamicPorts?: NomadPort[];
						ReservedPorts?: NomadPort[];
					}[];
					Services?: NomadSvc[];
					Tasks?: { Services?: NomadSvc[] }[];
				}[];
			}>(`/job/${encodeURIComponent(id)}`);
			for (const tg of job.TaskGroups ?? []) {
				const portByLabel = new Map<string, number>();
				for (const net of tg.Networks ?? []) {
					for (const p of [
						...(net.ReservedPorts ?? []),
						...(net.DynamicPorts ?? []),
					]) {
						if (p.Label) portByLabel.set(p.Label, p.Value || p.To || 0);
					}
				}
				const svcs = [
					...(tg.Services ?? []),
					...(tg.Tasks ?? []).flatMap((t) => t.Services ?? []),
				];
				for (const s of svcs) {
					if (!s.Name) continue;
					names.add(s.Name);
					const p = s.PortLabel ? portByLabel.get(s.PortLabel) : undefined;
					if (p) jobPortByName.set(s.Name, p);
				}
			}
		} catch {
			// skip unreadable job
		}
	}
	return Promise.all(
		[...names].map(async (name) => ({
			name,
			port: jobPortByName.get(name) ?? (await consulServicePort(name)),
		})),
	);
};

// Free-form Nomad job JSON we read and patch in place.
type NomadJob = any;

/**
 * Wire a Nomad-Pack deployment's domains into nomploy's ingress by patching the
 * deployed pack job(s): set each service's `Provider = "consul"` and inject the
 * Traefik router tags for the domains that target it (the SAME tags a compose
 * service gets, via {@link generateConsulTags}). Then re-register the job.
 *
 * This routes packs through the existing `consulCatalog` provider — which BOTH
 * the hub and the HA pool already read, health-aware and following alloc moves
 * automatically — so there's no file-provider config, no Consul-KV mirror and no
 * reconcile loop. Packs default their service to Nomad-native registration
 * (invisible to consulCatalog); this makes them first-class like compose apps.
 * Re-run on every deploy (nomad-pack run re-creates the job from the template,
 * which resets Provider/Tags). Domains use the DNS-01 resolver when configured
 * (HTTP-01 can't work behind the pool). Idempotent; empty domains clears the tags.
 */
export const applyPackDomains = async (
	compose: Pick<Compose, "appName"> & { domains?: Domain[] },
): Promise<void> => {
	const domains = applyDefaultCertResolver(
		compose.domains ?? [],
		await getDefaultCertResolver().catch(() => "letsencrypt"),
	);

	let jobs: { ID: string; Meta?: Record<string, string> }[] = [];
	try {
		jobs = await nomadFetch("/jobs?meta=true");
	} catch {
		return;
	}
	const ids = jobs
		.filter((j) => j.Meta?.["pack.deployment_name"] === compose.appName)
		.map((j) => j.ID);

	for (const id of ids) {
		let job: NomadJob;
		try {
			job = await nomadFetch(`/job/${encodeURIComponent(id)}`);
		} catch {
			continue;
		}
		let changed = false;
		for (const tg of job.TaskGroups ?? []) {
			const svcs = [
				...(tg.Services ?? []),
				...(tg.Tasks ?? []).flatMap((t: NomadJob) => t.Services ?? []),
			];
			for (const s of svcs) {
				if (!s.Name) continue;
				const svcDomains = domains.filter(
					(d) => d.serviceName === s.Name && d.host,
				);
				// consulCatalog routes this once it's a Consul service with the tags.
				s.Provider = "consul";
				s.Tags = generateConsulTags(compose.appName, s.Name, svcDomains);
				changed = true;
			}
		}
		if (changed) {
			await nomadPost("/jobs", { Job: job }).catch((e) =>
				console.error(`pack-domains: re-register ${id} failed:`, e),
			);
		}
	}
};
