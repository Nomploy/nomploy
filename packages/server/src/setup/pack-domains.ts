import type {
	compose as composeTable,
	domains as domainsTable,
} from "../db/schema";
import {
	applyDefaultCertResolver,
	getDefaultCertResolver,
} from "../services/cert-resolver";
import {
	generateConsulTags,
	type NomadComposeNested,
	resolveForcePull,
	resolveNomadEnvVars,
} from "../utils/builders/nomad";
import {
	getPackJobIds,
	type NomadJob,
	nomadFetch,
	patchPackJobs,
} from "./pack-nomad";
import type { PackScalingCompose } from "./pack-scaling";

/**
 * The secrets-template JSON (same consul-template body as the compose/app builder's
 * generateSecretsTemplate) that loads the job's Nomad Variable `nomad/jobs/<jobId>`
 * as env. The task reads it through its own workload identity (Nomad grants read to
 * its own job path), so the values never touch the job spec. change_mode=restart
 * rolls the task when a secret changes. Skips config-file keys (nmplcfg_*).
 */
const secretsTemplateJson = (jobId: string) => ({
	DestPath: "secrets/nomploy.env",
	Envvars: true,
	ChangeMode: "restart",
	EmbeddedTmpl: `{{- with nomadVar "nomad/jobs/${jobId}" }}
{{- range $k, $v := . }}
{{- $isCfg := false }}
{{- if ge (len $k) 8 }}{{ if eq (slice $k 0 8) "nmplcfg_" }}{{ $isCfg = true }}{{ end }}{{ end }}
{{- if not $isCfg }}
{{ $k }}={{ $v.Value }}
{{- end }}
{{- end }}
{{- end }}
`,
});

/**
 * Inject the panel's Environment-tab env and (opt-in) Nomad-Variable secrets into a
 * rendered pack job's tasks — the same env + secrets a compose/app service gets, so
 * extra env / SMTP creds can be set on a pack deploy, not only via the pack's own
 * HCL variables. Env merges over the pack template's env (user value wins); secrets
 * are added as a template reading nomad/jobs/<thisJobId> (the Variable is written
 * separately, keyed to the same job id — see registerPackDeployment).
 */
/**
 * Default a STATELESS pack job away from the control-plane node with a soft
 * negative affinity (mirrors controlPlanePin for compose/app), so packs don't
 * drift onto the small hub and starve the panel's zero-downtime roll. Soft, so a
 * single-node install still schedules. Skipped when the job has a volume (stateful
 * — leave placement alone) or already has a control-plane constraint (the deploy
 * form's Placement "Workers only" override).
 */
/**
 * Honor the service's Force Pull toggle on a pack job: set each docker task's
 * `force_pull` from resolveForcePull (the same rule compose/app use). Without this
 * a pack never re-pulled a moving tag (e.g. :latest), because its docker config
 * comes from the rendered template, not the builder.
 */
const applyForcePullToJob = (job: NomadJob, forcePull?: boolean): void => {
	for (const tg of job.TaskGroups ?? []) {
		for (const task of tg.Tasks ?? []) {
			const image = task.Config?.image;
			if (task.Driver !== "docker" || !image) continue;
			task.Config.force_pull = resolveForcePull(image, forcePull);
		}
	}
};

// Nomad durations are nanoseconds in the job JSON.
const SECONDS = 1_000_000_000;

const tagsAreHttp = (tags: string[]): boolean =>
	tags.some((t) => t.includes("Host(") || t === "traefik.enable=true");

// A group is stateful (can't run two allocs at once) if it mounts any persistent
// volume — a Nomad group volume, a group VolumeMount, or a docker named-volume
// `mount { type = "volume" }` in a task's Config.
const groupHasVolume = (tg: NomadJob): boolean => {
	if (Object.keys(tg.Volumes ?? {}).length > 0) return true;
	return (tg.Tasks ?? []).some((t: NomadJob) => {
		if ((t.VolumeMounts ?? []).length > 0) return true;
		const m = t.Config?.mount;
		const mounts = Array.isArray(m) ? m : m ? [m] : [];
		return mounts.some((x: NomadJob) => x?.type === "volume");
	});
};

/**
 * Make pack deploys zero-downtime where it's safe: enable a canary rollout on every
 * STATELESS HTTP group (has a Traefik `Host(...)` router, no persistent volume). The
 * canary runs dark (`canary_tags = ["traefik.enable=false"]`) until healthy, then
 * auto-promotes (traffic cuts over) and the old alloc drains via the group's
 * shutdown_delay. health_check uses Consul "checks" when the service has one, else
 * "task_states" (the task simply running) — otherwise canary=1 with nothing to check
 * would stall until the healthy_deadline. Stateful/DB groups (volume) stay rolling —
 * two allocs can't share one volume.
 */
const applyCanaryToJob = (job: NomadJob): void => {
	for (const tg of job.TaskGroups ?? []) {
		const services = (tg.Services ?? []) as NomadJob[];
		const httpServices = services.filter((s) => tagsAreHttp(s.Tags ?? []));
		if (httpServices.length === 0) continue; // only user-facing HTTP groups
		if (groupHasVolume(tg)) continue; // stateful — can't overlap allocs
		const hasCheck = services.some((s) => (s.Checks ?? []).length > 0);
		tg.Update = {
			...(tg.Update ?? {}),
			Canary: 1,
			MaxParallel: 1,
			AutoPromote: true,
			AutoRevert: true,
			HealthCheck: hasCheck ? "checks" : "task_states",
			MinHealthyTime: tg.Update?.MinHealthyTime ?? 10 * SECONDS,
			HealthyDeadline: tg.Update?.HealthyDeadline ?? 300 * SECONDS,
		};
		// The canary must not take traffic until it's promoted.
		for (const s of httpServices) {
			s.CanaryTags = ["traefik.enable=false"];
		}
	}
};

const applyStatelessAffinityToJob = (job: NomadJob): void => {
	const hasVolume = (job.TaskGroups ?? []).some(
		(tg: NomadJob) =>
			Object.keys(tg.Volumes ?? {}).length > 0 ||
			(tg.Tasks ?? []).some((t: NomadJob) => (t.VolumeMounts ?? []).length > 0),
	);
	if (hasVolume) return;
	const hasCpConstraint = (cs: NomadJob): boolean =>
		(cs ?? []).some((c: NomadJob) =>
			(c.LTarget ?? "").includes("nomploy_control_plane"),
		);
	if (hasCpConstraint(job.Constraints)) return;
	for (const tg of job.TaskGroups ?? []) {
		if (hasCpConstraint(tg.Constraints)) continue;
		tg.Affinities = [
			...(tg.Affinities ?? []),
			{
				LTarget: "${meta.nomploy_control_plane}",
				RTarget: "true",
				Operand: "=",
				Weight: -100,
			},
		];
	}
};

const applyEnvAndSecretsToJob = (
	job: NomadJob,
	env: Record<string, string>,
	secretsEnabled: boolean,
): void => {
	const hasEnv = Object.keys(env).length > 0;
	if (!hasEnv && !secretsEnabled) return;
	for (const tg of job.TaskGroups ?? []) {
		for (const task of tg.Tasks ?? []) {
			if (hasEnv) task.Env = { ...(task.Env ?? {}), ...env };
			if (secretsEnabled) {
				task.Templates = [
					...(task.Templates ?? []),
					secretsTemplateJson(job.ID),
				];
			}
		}
	}
};

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
			// Preserve the opt-in metrics tags the pack set on its service — we
			// overwrite s.Tags below, so carry nomploy.metrics.port=<port> and
			// nomploy.metrics.auth=<profile> over (the OTel Collector scrapes by
			// them; see setup/otel-collector.ts). The Provider flip to consul also
			// makes the service visible to consul_sd discovery.
			const existingTags = Array.isArray(s.Tags) ? (s.Tags as string[]) : [];
			const metricsTags = existingTags.filter(
				(t) => typeof t === "string" && t.startsWith("nomploy.metrics."),
			);
			// consulCatalog routes this once it's a Consul service with the tags.
			s.Provider = "consul";
			const traefikTags = generateConsulTags(appName, s.Name, svcDomains);
			s.Tags = [...traefikTags, ...metricsTags];
			// Hide a canary alloc from Traefik until it's promoted — the same
			// mechanism the panel job uses (see nomad-panel.ts canary_tags).
			// Without it a canary registers with the routing tags while still
			// starting/unhealthy, and consulCatalog drops the whole service when
			// no instance is passing (the count=1 cutover window) → a 404 during
			// the roll. canary_tags keeps the old alloc serving until the canary
			// is healthy and promoted, then Nomad swaps in the real tags. Gated on
			// the Traefik (routing) tags only — a metrics-only service isn't routed.
			s.CanaryTags = traefikTags.length > 0 ? ["traefik.enable=false"] : [];
			if (traefikTags.length > 0) routed = true;
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
	compose: NomadComposeNested & { domains?: Domain[] },
): Promise<(job: NomadJob) => void> => {
	const domains = applyDefaultCertResolver(
		compose.domains ?? [],
		await getDefaultCertResolver().catch(() => "letsencrypt"),
	);
	const { applyScalingToJob } = await import("./pack-scaling");
	// Environment-tab env + (opt-in) Nomad-Variable secrets, injected into every
	// task — so a pack deploy can take extra env / secrets like a compose/app does.
	const env = resolveNomadEnvVars(compose);
	const secretsEnabled = !!compose.nomadSecretsEnabled;
	return (job) => {
		applyDomainsToJob(job, compose.appName, domains);
		applyScalingToJob(job, compose);
		applyEnvAndSecretsToJob(job, env, secretsEnabled);
		applyStatelessAffinityToJob(job);
		applyForcePullToJob(job, compose.forcePull ?? undefined);
		// Zero-downtime: canary rollout on stateless HTTP groups.
		applyCanaryToJob(job);
		// Stamp a changing meta so every deploy is a NEW job version → a fresh alloc,
		// otherwise an identically-rendered pack (same `:latest` image + same vars) is
		// a no-op and Nomad never reschedules — so force_pull never runs and the new
		// image is never pulled. Mirrors how apps bump meta.deployed_at.
		job.Meta = {
			...(job.Meta ?? {}),
			nomploy_deployed_at: String(Date.now()),
		};
	};
};
