import type {
	compose as composeTable,
	domains as domainsTable,
} from "../db/schema";
import {
	applyDefaultCertResolver,
	getDefaultCertResolver,
} from "../services/cert-resolver";
import { generateConsulTags } from "../utils/builders/nomad";
import {
	getPackJobIds,
	type NomadJob,
	nomadFetch,
	patchPackJobs,
} from "./pack-nomad";
import type { PackScalingCompose } from "./pack-scaling";

type Compose = typeof composeTable.$inferSelect;
type Domain = typeof domainsTable.$inferSelect;

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
	const ids = await getPackJobIds(appName);

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

/**
 * Patch one pack job's service stanzas for ingress: set each service's
 * `Provider = "consul"` and inject the Traefik router tags for the domains that
 * target it (the SAME tags a compose service gets, via {@link generateConsulTags}).
 * Returns whether the job changed. Routes packs through the existing
 * `consulCatalog` provider — which BOTH the hub and the HA pool already read,
 * health-aware and following alloc moves — so there's no file-provider config,
 * no Consul-KV mirror and no reconcile loop. Idempotent; empty domains clears the
 * tags. `domains` must already carry the default cert resolver.
 */
export const applyDomainsToJob = (
	job: NomadJob,
	appName: string,
	domains: Domain[],
): boolean => {
	let changed = false;
	for (const tg of job.TaskGroups ?? []) {
		const svcs = [
			...(tg.Services ?? []),
			...(tg.Tasks ?? []).flatMap((t: NomadJob) => t.Services ?? []),
		];
		let routed = false;
		for (const s of svcs) {
			if (!s.Name) continue;
			const svcDomains = domains.filter(
				(d) => d.serviceName === s.Name && d.host,
			);
			// consulCatalog routes this once it's a Consul service with the tags.
			s.Provider = "consul";
			s.Tags = generateConsulTags(appName, s.Name, svcDomains);
			// Hide a canary alloc from Traefik until it's promoted — the same
			// mechanism the panel job uses (see nomad-panel.ts canary_tags).
			// Without it a canary registers with the routing tags while still
			// starting/unhealthy, and consulCatalog drops the whole service when
			// no instance is passing (the count=1 cutover window) → a 404 during
			// the roll. canary_tags keeps the old alloc serving until the canary
			// is healthy and promoted, then Nomad swaps in the real tags.
			s.CanaryTags = s.Tags.length > 0 ? ["traefik.enable=false"] : [];
			if (s.Tags.length > 0) routed = true;
			changed = true;
		}
		// Graceful drain at the GROUP level. Nomad honors shutdown_delay on the
		// group/task, NOT the service — a service-level set is silently dropped
		// (that's why the earlier service-level attempt was a no-op and pack
		// canary rolls still blipped). On promotion the old alloc deregisters from
		// Consul then stays alive this long before stopping, so Traefik's
		// consulCatalog (~5s refresh) picks up the promoted alloc before the old
		// disappears — overlap, not a gap. Mirrors the panel job's group
		// shutdown_delay. Skip if the pack author already set one.
		if (routed && !tg.ShutdownDelay) {
			tg.ShutdownDelay = 10_000_000_000;
			changed = true;
		}
	}
	return changed;
};

/**
 * Wire a Nomad-Pack deployment's domains into nomploy's ingress by patching the
 * deployed pack job(s) and re-registering. Packs default their service to
 * Nomad-native registration (invisible to consulCatalog); this makes them
 * first-class like compose apps. Re-run on every deploy (nomad-pack run
 * re-creates the job from the template, which resets Provider/Tags). Domains use
 * the DNS-01 resolver when configured (HTTP-01 can't work behind the pool).
 *
 * Prefer {@link applyPackJobPatches} on the deploy path — it applies domains AND
 * scaling in a single re-registration. This standalone form stays for the
 * stop/clear path (domains: []).
 */
export const applyPackDomains = async (
	compose: Pick<Compose, "appName"> & { domains?: Domain[] },
): Promise<void> => {
	const domains = applyDefaultCertResolver(
		compose.domains ?? [],
		await getDefaultCertResolver().catch(() => "letsencrypt"),
	);
	await patchPackJobs(compose.appName, (job) =>
		applyDomainsToJob(job, compose.appName, domains),
	);
};

/**
 * Apply BOTH the domain tags and the panel's scaling overrides (count / reserved
 * resources / autoscaling) to a pack deployment's jobs in a SINGLE
 * re-registration — the deploy path's entry point. Splitting these into two
 * passes would re-register (and reschedule) the pack twice.
 */
export const applyPackJobPatches = async (
	compose: Pick<Compose, "appName" | "serviceScaling"> &
		PackScalingCompose & { domains?: Domain[] },
): Promise<void> => {
	const domains = applyDefaultCertResolver(
		compose.domains ?? [],
		await getDefaultCertResolver().catch(() => "letsencrypt"),
	);
	const { applyScalingToJob } = await import("./pack-scaling");
	await patchPackJobs(compose.appName, (job) => {
		const d = applyDomainsToJob(job, compose.appName, domains);
		const s = applyScalingToJob(job, compose);
		return d || s;
	});
};

/**
 * Build the mutator applied to a pack's job(s) at their SINGLE registration
 * (registerRenderedPackJobs): the same domains (Traefik tags + canary_tags +
 * shutdown_delay) and scaling (count/resources/autoscaling) overrides that
 * {@link applyPackJobPatches} used to apply as a second re-registration. Folding
 * them into the one register is what keeps a canary roll a single clean
 * transition (no 404 window). Resolves domains + the default cert resolver once,
 * up front, so the returned patch is synchronous.
 */
export const buildPackJobPatch = async (
	compose: Pick<Compose, "appName" | "serviceScaling"> &
		PackScalingCompose & { domains?: Domain[] },
): Promise<(job: NomadJob) => void> => {
	const domains = applyDefaultCertResolver(
		compose.domains ?? [],
		await getDefaultCertResolver().catch(() => "letsencrypt"),
	);
	const { applyScalingToJob } = await import("./pack-scaling");
	return (job) => {
		applyDomainsToJob(job, compose.appName, domains);
		applyScalingToJob(job, compose);
	};
};
