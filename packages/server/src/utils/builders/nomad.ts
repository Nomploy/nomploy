import { join } from "node:path";
import { paths } from "@nomploy/server/constants";
import type { Domain } from "@nomploy/server/services/domain";
import type { InferResultType } from "@nomploy/server/types/with";
import { allServers, readCluster } from "../../setup/nomad-mesh";
import { encodeBase64, getEnvironmentVariablesObject } from "../docker/utils";
import { parseComposeToNomadServices } from "./nomad-parser";

export type NomadComposeNested = InferResultType<
	"compose",
	{ environment: { with: { project: true } }; mounts: true; domains: true }
>;

export interface NomadPort {
	label: string;
	to: number;
	protocol?: "tcp" | "udp";
}

export interface NomadServiceSpec {
	name: string;
	image: string;
	ports: NomadPort[];
	replicas: number;
	env: Record<string, string>;
	entrypoint?: string[];
	healthCheck?: {
		type: string;
		path?: string;
		interval: string;
		timeout: string;
	};
	resources?: {
		cpu?: number;
		/** Scheduling reservation (soft floor), MB. Docker `mem_reservation`. */
		memory?: number;
		/** Hard cgroup cap the task may burst to, MB. Docker `mem_limit`. */
		memoryMax?: number;
		/** Number of NVIDIA GPUs to request (nomad-device-nvidia). */
		gpus?: number;
	};
	/**
	 * Compose `volumes:` for this service — mapped to docker volumes so data
	 * survives a redeploy (a new alloc). See generateVolumesConfig.
	 */
	volumes?: {
		/** Named volume, absolute host path, or relative path. Undefined = anonymous. */
		source?: string;
		/** Mount path inside the container. */
		target: string;
		/** True for a named (declared) volume vs a host bind mount. */
		named: boolean;
		/** Mount mode, e.g. "ro". */
		mode?: string;
	}[];
	/**
	 * `file` mounts — inline content written into the container at `mountPath`.
	 * Rendered via a Nomad `template` stanza (node-agnostic, unlike a host bind), so
	 * the config file follows the alloc to whatever node it lands on. See
	 * generateFileMounts.
	 */
	fileMounts?: { content: string; mountPath: string }[];
	scaling?: {
		min: number;
		max: number;
		cpuTarget?: number;
		memoryTarget?: number;
		cooldown?: string;
		evaluationInterval?: string;
	};
	/**
	 * Inject secrets from the job's Nomad Variable (nomad/jobs/<appName>) as env,
	 * via a template block read by the task's workload identity. Opt-in: the value
	 * never appears in the job HCL. See generateSecretsTemplate.
	 */
	secrets?: boolean;
}

// Allocation DNS servers: every server node (hub + HA servers) runs a dnsmasq on
// its own WireGuard IP that forwards *.service.consul to its local Consul and
// everything else upstream. Listing them ALL means name resolution fails over if
// the hub dies — the raft keeps scheduling and allocs keep resolving via a
// surviving server. Falls back to the hub IP when cluster.json isn't readable
// (e.g. unit tests / a fresh single-node install before it's written).
const HUB_DNS_IP = "10.10.0.1";
export const clusterDnsServers = (): string[] => {
	try {
		const cluster = readCluster();
		if (!cluster) return [HUB_DNS_IP];
		const ips = allServers(cluster)
			.map((s) => s.wgIp)
			.filter(Boolean);
		return ips.length > 0 ? ips : [HUB_DNS_IP];
	} catch {
		return [HUB_DNS_IP];
	}
};

// ─── Post-deploy health check ────────────────────────────────────────────────

// A translated compose/app job carries an update{} block, so `nomad job run`
// blocks and fails on a bad rollout. But a native HCL job may omit update{}, and
// `nomad-pack run` returns at registration — both can exit 0 while allocations
// crash or fail to place. This Python probe (run after those deploys) resolves
// the deployed job id(s) (for a pack, via the pack.deployment_name meta) and
// polls their allocations: it FAILS the deploy only on a definitive failure (all
// current-version allocations failed/lost), and merely WARNS on a timeout that's
// still pending — so a slow image pull isn't mistaken for a failure. Must contain
// no `${` or backticks (it lives inside a JS template literal).
const HEALTH_PROBE_PY = `import json, subprocess, sys, time
name, mode = sys.argv[1], sys.argv[2]
deadline = time.time() + 150
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
ids = []
while time.time() < deadline:
    ids = job_ids()
    if ids:
        break
    time.sleep(3)
if not ids:
    print("could not resolve deployed job(s) to health-check; skipping")
    sys.exit(0)
def status(jid):
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
while time.time() < deadline:
    sts = {jid: status(jid) for jid in ids}
    bad = [k for k, v in sts.items() if v in ("failed", "dead")]
    if bad:
        print("Allocations failed for: %s" % ", ".join(bad))
        sys.exit(1)
    if all(v == "running" for v in sts.values()):
        print("All deployed jobs have running allocations")
        sys.exit(0)
    time.sleep(4)
print("Not confirmed healthy within the window (still pending) - check the dashboard")
sys.exit(0)
`;

// Shell that runs the probe after a deploy. mode "job" checks the job id == name;
// mode "pack" resolves the pack's real jobs first. Base64 so no quoting hell.
// Guarded on python3 so a host without it degrades to skipping the check rather
// than failing an otherwise-successful deploy.
const healthCheckSnippet = (name: string, mode: "job" | "pack"): string =>
	`\tif command -v python3 >/dev/null 2>&1; then\n\t\techo "Verifying deployment health…"\n\t\techo "${encodeBase64(HEALTH_PROBE_PY)}" | base64 -d | python3 - "${name}" "${mode}"\n\telse\n\t\techo "Skipping health check (python3 unavailable)"\n\tfi\n`;

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Build the full Nomad deploy command from a compose configuration.
 * This replaces getBuildComposeCommand for Nomad orchestrator.
 */
export const getBuildNomadCommand = async (
	compose: NomadComposeNested,
): Promise<string> => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { appName, composeFile, domains } = compose;
	const projectPath = join(COMPOSE_PATH, appName, "code");
	const jobFilePath = join(projectPath, `${appName}.nomad.hcl`);

	// Native Nomad jobspec passthrough: if the source is already a Nomad HCL job
	// (a top-level `job "\u2026" {` block) rather than docker-compose YAML, deploy it
	// verbatim \u2014 no translation, and no docker compose build/push (the jobspec
	// references already-built images and owns its own ${NOMAD_*} interpolation,
	// which we must NOT substitute). This is the "deploy using Nomad syntax" path.
	// A native Nomad jobspec opens with a `job "<name>" {` block. Requiring the
	// name + opening brace (not just `job "`) avoids misreading a compose file
	// that merely contains those tokens as HCL.
	const isNativeHcl = /(^|\n)\s*job\s+"[^"]+"\s*\{/.test(composeFile);

	let jobSpec: string;
	if (isNativeHcl) {
		// Lifecycle + observability (stop/start/remove, logs, allocations) all
		// address the job by appName. A raw jobspec declares its own job id
		// (job "<name>" {…}), usually != appName — left as-is, Stop/Remove would be
		// no-ops (orphaning the job) and Logs/Allocations would come up empty. So
		// rewrite a single-job spec's id to appName. Multi-job specs are left
		// verbatim (advanced use — the author owns their lifecycle).
		const jobDecls = composeFile.match(/(?:^|\n)\s*job\s+"[^"]+"\s*\{/g) ?? [];
		jobSpec =
			jobDecls.length === 1
				? composeFile.replace(
						/((?:^|\n)\s*job\s+)"[^"]+"(\s*\{)/,
						`$1"${appName}"$2`,
					)
				: composeFile;
	} else {
		// Resolve all env vars (project + environment + service)
		const envVars = resolveNomadEnvVars(compose);
		// Parse compose file into Nomad services
		const services = parseComposeToNomadServices(composeFile, envVars);
		// Generate Nomad HCL job spec. Isolated projects join the Connect mesh.
		const segmentation = compose.environment?.project?.isolated
			? { projectId: compose.environment.projectId }
			: undefined;
		// Isolated projects use the Connect mesh (per-service groups + sidecars);
		// everything else uses the single-group, compose-faithful translation so
		// services reach each other by name like Docker Compose.
		jobSpec = segmentation
			? generateNomadJobSpec(
					appName,
					services,
					domains,
					segmentation,
					compose.nodePool,
				)
			: generateNomadComposeJobSpec(
					appName,
					services,
					domains,
					compose.nodePool,
				);
	}
	const encodedJobSpec = encodeBase64(jobSpec);

	// Compose sources build+push their image first; a native jobspec skips that.
	const buildSteps = isNativeHcl
		? ""
		: `
	# Build Docker image
	docker compose build 2>&1
	echo "Docker image built: \u2705"

	# Push to registry
	docker compose push 2>&1
	echo "Docker image pushed: \u2705"
`;

	return `
set -e
{
	cd "${projectPath}"

	# Write Nomad job file
	echo "${encodedJobSpec}" | base64 -d > "${jobFilePath}"
	echo "Nomad job file written: \u2705"
${buildSteps}
	# Deploy to Nomad
	nomad job run "${jobFilePath}" 2>&1
	echo "Nomad Job Deployed: \u2705"
${isNativeHcl ? healthCheckSnippet(appName, "job") : ""}} || {
	echo "Error: \u274c Nomad deployment failed"
	exit 1
}
`;
};

/**
 * Build the deploy command for a Nomad Pack (composeType = "nomad-pack").
 * Writes the pack variables (composeFile, HCL) to a var-file, optionally
 * registers a custom pack registry, and runs `nomad-pack run`. The deployment is
 * named by appName so it maps back to nomploy for status/logs.
 */
export const getBuildNomadPackCommand = (
	compose: NomadComposeNested,
): string => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { appName, composeFile, nomadPack, nomadPackRegistry } = compose;
	const projectPath = join(COMPOSE_PATH, appName, "code");
	const varFile = join(projectPath, `${appName}.vars.hcl`);

	if (!nomadPack || !nomadPack.trim()) {
		return 'echo "Error: no Nomad Pack specified"; exit 1';
	}

	const hasVars = !!composeFile && composeFile.trim().length > 0;
	const encodedVars = encodeBase64(composeFile || "");
	// A custom registry (git URL) is added under a fixed local name, then
	// referenced with --registry. With no custom registry we deploy from the
	// community registry — which must be added to the local cache first, or
	// `nomad-pack run <pack>` fails with "Failed To Find Pack" on a fresh host
	// (e.g. right after a panel roll). Both adds tolerate a non-zero exit so a
	// re-deploy (registry already present) doesn't fail.
	const registryName = "nomploy-custom";
	const addRegistry = nomadPackRegistry
		? `\tnomad-pack registry add ${registryName} "${nomadPackRegistry}" 2>&1 || true\n`
		: "\tnomad-pack registry add default github.com/hashicorp/nomad-pack-community-registry 2>&1 || true\n";
	const registryFlag = nomadPackRegistry ? ` --registry ${registryName}` : "";
	const varFlag = hasVars ? ` --var-file="${varFile}"` : "";
	const writeVars = hasVars
		? `\techo "${encodedVars}" | base64 -d > "${varFile}"\n\techo "Pack variables written"\n`
		: "";

	return `
set -e
{
	command -v nomad-pack >/dev/null 2>&1 || { echo "Error: nomad-pack is not installed on this host. Nomad Pack deploys run on the control plane — deploy this compose without a specific server, or install nomad-pack on the target."; exit 1; }
	mkdir -p "${projectPath}"
${writeVars}${addRegistry}	nomad-pack run ${nomadPack}${registryFlag}${varFlag} --name "${appName}" 2>&1
	echo "Nomad Pack deployed"
${healthCheckSnippet(appName, "pack")}} || {
	echo "Error: Nomad Pack deployment failed"
	exit 1
}
`;
};

// ─── Env Var Resolution ──────────────────────────────────────────────────────

/**
 * Resolve environment variables for a Nomad job.
 * No shell escaping needed — values go directly into HCL.
 */
export const resolveNomadEnvVars = (
	compose: NomadComposeNested,
): Record<string, string> => {
	return getEnvironmentVariablesObject(
		compose.env,
		compose.environment.project.env,
		compose.environment.env,
	);
};

// ─── HCL Generation ──────────────────────────────────────────────────────────

/**
 * Generate a complete Nomad job HCL file
 */
/**
 * Phase B segmentation. When present, the job's services join the Consul Connect
 * mesh: each group runs in bridge mode, the primary service gets an Envoy sidecar
 * with transparent proxy, and every mesh service is tagged with
 * meta.nomploy_project so the intentions engine can group it by project and
 * enforce "who can talk to what". Absent = today's flat, host-networked behavior.
 */
export interface NomadSegmentation {
	projectId: string;
}

// Consul tag that marks a mesh service's project. The intentions engine groups
// services by this tag (catalog listings return tags, not meta) to enforce
// project-level segmentation. Value: `${NOMPLOY_PROJECT_TAG}<projectId>`.
export const NOMPLOY_PROJECT_TAG = "nomploy-project=";

/**
 * Deployment strategy for a job's `update` stanza. Absent = today's default
 * (rolling, one alloc at a time). `canary > 0` runs N canary allocations
 * alongside the running version and holds the new version until they're healthy;
 * `autoPromote` promotes automatically once healthy, otherwise it waits for a
 * manual promote (health-gated). auto_revert stays on either way.
 */
export interface NomadUpdateConfig {
	maxParallel?: number;
	canary?: number;
	autoPromote?: boolean;
}

const generateUpdateBlock = (update?: NomadUpdateConfig): string => {
	const maxParallel =
		update?.maxParallel && update.maxParallel > 0 ? update.maxParallel : 1;
	const canary = update?.canary && update.canary > 0 ? update.canary : 0;
	// Canary lines only when canary > 0 — otherwise the stanza is byte-identical
	// to the historical rolling default, so existing apps are unaffected.
	const canaryLines =
		canary > 0
			? `\n    canary           = ${canary}\n    auto_promote     = ${update?.autoPromote ? "true" : "false"}`
			: "";
	return `  update {
    max_parallel     = ${maxParallel}
    health_check     = "checks"
    min_healthy_time = "10s"
    healthy_deadline = "5m"
    auto_revert      = true${canaryLines}
  }`;
};

/**
 * Compose → Nomad, faithful to Docker Compose's single-host networking.
 *
 * Docker Compose runs all of a project's services on ONE host and lets them reach
 * each other by service name (`db:5432`, `redis:6379`). Nomad has no per-project
 * network and assigns dynamic ports, so the previous per-service-group translation
 * broke that: a service like `db` with no published port registered nothing in
 * Consul and never resolved.
 *
 * We mirror compose instead: ALL services go into ONE task group in `bridge` mode,
 * so every task shares a single network namespace (like compose's project network).
 * An `extra_hosts` alias per service name → 127.0.0.1 is injected into each task,
 * so `db:5432` resolves to the db task in the shared netns — exactly like compose,
 * with NO port declaration needed for inter-service traffic. Only ports the compose
 * actually declares are mapped out of the group (for Traefik/domains + Consul).
 *
 * The isolated/Connect-mesh path keeps the per-service-group form (generateNomadJobSpec
 * with segmentation) — the sidecar model needs one service identity per group.
 */
export const generateNomadComposeJobSpec = (
	appName: string,
	services: NomadServiceSpec[],
	domains: Domain[],
	nodePool?: string | null,
	update?: NomadUpdateConfig,
): string => {
	// Port labels must be unique WITHIN the single group (two services could both
	// expose e.g. 3000), so scope each label by its service name.
	const relabeled = services.map((s) => ({
		...s,
		ports: s.ports.map((p) => ({ ...p, label: `${s.name}-${p.to}` })),
	}));

	const dnsServers = clusterDnsServers()
		.map((ip) => `"${ip}"`)
		.join(", ");
	const portLines = relabeled
		.flatMap((s) =>
			s.ports.map(
				(p) => `      port "${p.label}" {\n        to = ${p.to}\n      }`,
			),
		)
		.join("\n");
	const networkBlock = `    network {
      mode = "bridge"
      dns {
        servers  = [${dnsServers}]
        searches = ["service.consul"]
      }
${portLines}
    }`;

	// Consul registrations (domain routing + discovery) for services with ports.
	const consulServices = relabeled
		.map((s) => generateConsulServices(appName, s, domains))
		.filter(Boolean)
		.join("\n\n");

	// Every compose service name resolves to localhost inside the shared netns.
	const hostAliases = relabeled.map((s) => `"${s.name}:127.0.0.1"`).join(", ");

	const tasks = relabeled
		.map((s) => {
			const envBlock = generateEnvBlock(s.env);
			const secretsBlock = s.secrets
				? `\n\n${generateSecretsTemplate(appName)}`
				: "";
			const resourcesBlock = generateResourcesBlock(s.resources);
			const entrypointLine = s.entrypoint
				? `\n        entrypoint = ${JSON.stringify(s.entrypoint)}`
				: "";
			const portsConfig =
				s.ports.length > 0
					? `\n        ports = [${s.ports.map((p) => `"${p.label}"`).join(", ")}]`
					: "";
			const fileMounts = generateFileMounts(s.fileMounts);
			const allVolumeEntries = [
				...volumeEntries(appName, s.volumes),
				...fileMounts.volumes,
			];
			const volumesConfig = allVolumeEntries.length
				? `\n        volumes = [${allVolumeEntries.join(", ")}]`
				: "";
			return `    task "${s.name}" {
      driver = "docker"

      config {
        image = "${s.image}"
        extra_hosts = [${hostAliases}]${portsConfig}${entrypointLine}${volumesConfig}
      }

${envBlock}${secretsBlock}${fileMounts.templates}

${resourcesBlock}
    }`;
		})
		.join("\n\n");

	const nodePoolLine =
		nodePool && nodePool !== "default" ? `  node_pool = "${nodePool}"` : "";

	return `job "${appName}" {
  namespace = "default"
  type      = "service"
${nodePoolLine}
${generateUpdateBlock(update)}

  group "${appName}" {
    count = 1

    # Compose has no cross-task ordering here (tasks start together), so a service
    # that talks to another on boot (app → db) may need a few retries while its
    # dependency comes up. Be generous so transient startup ordering self-heals.
    restart {
      attempts = 5
      interval = "10m"
      delay    = "10s"
      mode     = "delay"
    }
${networkBlock}
${consulServices ? `\n${consulServices}\n` : ""}
${tasks}
  }
}
`;
};

export const generateNomadJobSpec = (
	appName: string,
	services: NomadServiceSpec[],
	domains: Domain[],
	segmentation?: NomadSegmentation,
	nodePool?: string | null,
	update?: NomadUpdateConfig,
): string => {
	const taskGroups = services
		.map((service) =>
			generateTaskGroup(appName, service, domains, segmentation),
		)
		.join("\n\n");

	// Target an autoscaling group's Nomad node pool when the service selects one;
	// unset/"default" runs in the built-in default pool.
	const nodePoolLine =
		nodePool && nodePool !== "default" ? `  node_pool = "${nodePool}"` : "";

	return `job "${appName}" {
  namespace = "default"
  type      = "service"
${nodePoolLine}
${generateUpdateBlock(update)}

${taskGroups}
}
`;
};

const generateTaskGroup = (
	appName: string,
	service: NomadServiceSpec,
	domains: Domain[],
	segmentation?: NomadSegmentation,
): string => {
	const envBlock = generateEnvBlock(service.env);
	const secretsBlock = service.secrets
		? `\n\n${generateSecretsTemplate(appName)}`
		: "";
	const consulServices = generateConsulServices(
		appName,
		service,
		domains,
		segmentation,
	);
	const resourcesBlock = generateResourcesBlock(service.resources);
	const scalingBlock = generateScalingBlock(service.scaling);
	const entrypointLine = service.entrypoint
		? `\n        entrypoint = ${JSON.stringify(service.entrypoint)}`
		: "";

	const hasPorts = service.ports.length > 0;
	// Always give the allocation cluster DNS: the control plane's dnsmasq forwards
	// *.service.consul to Consul and everything else upstream, so services reach
	// each other and their databases by name (e.g. a bare "<db-appName>" resolves
	// via the service.consul search domain). Ports are added when the service has
	// any.
	const portLines = service.ports
		.map((p) => `      port "${p.label}" {\n        to = ${p.to}\n      }`)
		.join("\n");
	// Connect (segmentation) requires bridge networking so the Envoy sidecar +
	// transparent-proxy iptables can live in the alloc's own netns. Flat mode
	// stays host-networked (default) as before. Mesh groups keep the Consul DNS
	// block (so the app resolves *.service.consul + *.virtual.consul) and set
	// transparent_proxy.no_dns=true — Docker's embedded resolver otherwise short-
	// circuits the proxy's own DNS redirect, and Nomad forbids network.dns with
	// transparent proxy unless no_dns is set.
	const networkModeLine = segmentation ? '\n      mode = "bridge"' : "";
	const dnsServers = clusterDnsServers()
		.map((ip) => `"${ip}"`)
		.join(", ");
	const networkBlock = `    network {${networkModeLine}
      dns {
        servers  = [${dnsServers}]
        searches = ["service.consul"]
      }
${portLines}
    }`;
	const portsConfig = hasPorts
		? `\n        ports = [${service.ports.map((p) => `"${p.label}"`).join(", ")}]`
		: "";
	// Persist the service's volumes/mounts as docker volumes (same mechanism as the
	// compose path). Without this an application/service with a mount ran on ephemeral
	// storage and lost its data on every redeploy. NOTE: docker volumes are node-local
	// — a stateful service with replicas>1 or that reschedules to another node won't
	// see the data; pin it to a single-node pool (or use a managed database, which is
	// pinned by design in nomad-database.ts). `file` mounts are rendered as templates
	// and bound from the alloc's local dir, so they share the same volumes list.
	const fileMounts = generateFileMounts(service.fileMounts);
	const allVolumeEntries = [
		...volumeEntries(appName, service.volumes),
		...fileMounts.volumes,
	];
	const volumesConfig = allVolumeEntries.length
		? `\n        volumes = [${allVolumeEntries.join(", ")}]`
		: "";

	// Spread replicas across distinct nodes so a multi-replica service uses the
	// whole cluster instead of bin-packing onto one box. Soft (spread, not a
	// distinct_hosts constraint) so it still schedules when replicas > nodes.
	const spreadBlock =
		service.replicas > 1
			? `    spread {
      attribute = "\${node.unique.id}"
    }
`
			: "";

	return `  group "${service.name}" {
    count = ${service.replicas}
${spreadBlock}
${scalingBlock}${networkBlock}
${
	hasPorts
		? `
${consulServices}
`
		: ""
}
    task "${service.name}" {
      driver = "docker"

      config {
        image = "${service.image}"${portsConfig}${entrypointLine}${volumesConfig}
      }

${envBlock}${secretsBlock}${fileMounts.templates}

${resourcesBlock}
    }
  }`;
};

const generateEnvBlock = (env: Record<string, string>): string => {
	const lines = Object.entries(env)
		.map(([key, value]) => `        ${key} = ${JSON.stringify(value)}`)
		.join("\n");

	return `      env {
${lines}
      }`;
};

/**
 * A template block that renders the job's secrets (stored in the Nomad Variable
 * nomad/jobs/<appName>) into an env file and loads them as environment variables.
 * The secret VALUES never appear in the job HCL — only this reference — so
 * `nomad job inspect` / the panel DB never expose them. The task reads the
 * variable through its automatic workload identity, which Nomad implicitly
 * grants read access to variables under its own nomad/jobs/<jobID> path (even
 * under an ACL deny-by-default policy). change_mode="restart" makes a secret
 * change roll the task without a redeploy once this block is present.
 *
 * Uses consul-template syntax ({{ }}) which HCL does not interpolate; the only
 * ${} here is the JS-side appName. Multi-line secret values aren't supported by
 * env-file injection (each line is one KEY=VALUE).
 */
const generateSecretsTemplate = (appName: string): string => {
	return `      template {
        destination = "secrets/nomploy.env"
        env         = true
        change_mode = "restart"
        data        = <<EOTPL
{{- with nomadVar "nomad/jobs/${appName}" }}
{{- range $k, $v := . }}
{{ $k }}={{ $v.Value }}
{{- end }}
{{- end }}
EOTPL
      }`;
};

const generateScalingBlock = (
	scaling?: NomadServiceSpec["scaling"],
): string => {
	if (!scaling) return "";

	const checks: string[] = [];

	if (scaling.cpuTarget) {
		checks.push(`
        check "cpu" {
          source = "nomad-apm"
          query  = "avg_cpu-allocated"

          strategy "target-value" {
            target = ${scaling.cpuTarget}
          }
        }`);
	}

	if (scaling.memoryTarget) {
		checks.push(`
        check "memory" {
          source = "nomad-apm"
          query  = "avg_memory-allocated"

          strategy "target-value" {
            target = ${scaling.memoryTarget}
          }
        }`);
	}

	if (checks.length === 0) return "";

	const cooldownLine = scaling.cooldown
		? `\n        cooldown            = "${scaling.cooldown}"`
		: "";
	const evalLine = scaling.evaluationInterval
		? `\n        evaluation_interval = "${scaling.evaluationInterval}"`
		: "";

	return `    scaling {
      min     = ${scaling.min}
      max     = ${scaling.max}
      enabled = true

      policy {${evalLine}${cooldownLine}
${checks.join("\n")}
      }
    }
`;
};

const generateResourcesBlock = (
	resources?: NomadServiceSpec["resources"],
): string => {
	// GPUs are scheduled via the nomad-device-nvidia plugin. Requires the node to
	// have GPU support enabled (Settings → Server → GPU). "nvidia/gpu" matches any
	// NVIDIA GPU the plugin fingerprints.
	const gpuBlock =
		resources?.gpus && resources.gpus > 0
			? `
        device "nvidia/gpu" {
          count = ${resources.gpus}
        }`
			: "";
	// Docker compose services are unbounded by default, and container runtimes that
	// size themselves to the cgroup limit (Node's V8 heap, the JVM) will OOM when the
	// hard cap equals the reservation — e.g. a Next.js app dies at a 512 MB cap with
	// its heap pinned near 256 MB. So reserve `memory` for scheduling but allow
	// bursting to `memory_max` (needs cluster memory oversubscription, enabled in
	// install.sh), mirroring the panel job's own 512→2048 pattern. An explicit compose
	// limit (`mem_limit` → memoryMax) wins; otherwise give generous headroom.
	const memory = resources?.memory || 512;
	const memoryMax = resources?.memoryMax ?? Math.max(memory * 4, 2048);
	const memoryMaxLine =
		memoryMax > memory ? `\n        memory_max = ${memoryMax}` : "";
	return `      resources {
        cpu    = ${resources?.cpu || 256}
        memory = ${memory}${memoryMaxLine}${gpuBlock}
      }`;
};

/** Docker volume names must be [a-zA-Z0-9][a-zA-Z0-9_.-]* — sanitize a source. */
const sanitizeVolumeName = (s: string): string =>
	s
		.replace(/[^a-zA-Z0-9_.-]+/g, "-")
		.replace(/^[-.]+/, "")
		.replace(/-+$/, "") || "vol";

/**
 * Map a service's compose `volumes:` to the docker driver's `volumes` config so
 * data PERSISTS across a redeploy (each deploy is a new alloc; without this the
 * container's writable layer — e.g. a Postgres data dir — is wiped every time).
 *
 * - Named volume  → `<appName>-<name>:<target>` docker named volume. Prefixed with
 *   the app so two apps that both declare e.g. `db_data` don't collide on the host;
 *   docker auto-creates it and it survives redeploys.
 * - Absolute bind → `<host>:<target>` passed through.
 * - Relative bind → a stable per-app host dir (there's no compose project dir on
 *   Nomad), so it still persists.
 * - Anonymous     → a stable per-app+target named volume (so it, too, persists).
 *
 * Requires the docker plugin's `volumes { enabled = true }` (set in install.sh).
 * NOTE: docker volumes are node-local — if the alloc reschedules to another node
 * the data does not follow. The compose model is single-host.
 */
const volumeEntries = (
	appName: string,
	volumes?: NomadServiceSpec["volumes"],
): string[] => {
	if (!volumes || volumes.length === 0) return [];
	return volumes.map((v) => {
		const mode = v.mode ? `:${v.mode}` : "";
		if (!v.source) {
			const name = `${appName}-${sanitizeVolumeName(v.target)}`;
			return `"${name}:${v.target}${mode}"`;
		}
		if (v.named) {
			return `"${appName}-${sanitizeVolumeName(v.source)}:${v.target}${mode}"`;
		}
		if (v.source.startsWith("/")) {
			return `"${v.source}:${v.target}${mode}"`;
		}
		const rel = sanitizeVolumeName(v.source.replace(/^\.\/?/, ""));
		return `"/var/lib/nomploy/volumes/${appName}/${rel}:${v.target}${mode}"`;
	});
};

const generateVolumesConfig = (
	appName: string,
	volumes?: NomadServiceSpec["volumes"],
): string => {
	const entries = volumeEntries(appName, volumes);
	return entries.length ? `\n        volumes = [${entries.join(", ")}]` : "";
};

/**
 * Render `file` mounts (inline config content) as Nomad `template` stanzas plus the
 * docker volume entries that mount each rendered file at its container path.
 *
 * A template is node-agnostic (Nomad writes it into the alloc's `local/` dir on
 * whatever node runs the task), unlike a host bind mount which would need the file
 * pre-placed on that specific node. Two layers of escaping keep arbitrary content
 * intact: HCL2 heredoc interpolation (`${` / `%{`) is escaped, and the template's
 * consul-template delimiters are set to unlikely tokens so the content's own
 * `{{ }}` / `${ }` are written verbatim rather than rendered.
 *
 * Returns `templates` (stanzas for the task body) and `volumes` (entries to append
 * to the docker `volumes` list, relative to the alloc dir where `local/` lives).
 */
const generateFileMounts = (
	fileMounts?: NomadServiceSpec["fileMounts"],
): { templates: string; volumes: string[] } => {
	if (!fileMounts || fileMounts.length === 0)
		return { templates: "", volumes: [] };
	const templates: string[] = [];
	const volumes: string[] = [];
	fileMounts.forEach((f, i) => {
		if (!f.mountPath) return;
		const dest = `local/file-${i}`;
		// Escape HCL2 heredoc interpolation so literal ${...}/%{...} survive parsing.
		// Function replacements return the text verbatim (a plain "$${" string would be
		// mangled by String.replace's own `$$`→`$` substitution).
		const data = f.content
			.replace(/\$\{/g, () => "$${")
			.replace(/%\{/g, () => "%%{");
		templates.push(`      template {
        destination     = ${JSON.stringify(dest)}
        change_mode     = "restart"
        left_delimiter  = "[[[["
        right_delimiter = "]]]]"
        data            = <<EOFILE
${data}
EOFILE
      }`);
		volumes.push(`"${dest}:${f.mountPath}"`);
	});
	return {
		templates: templates.length ? `\n\n${templates.join("\n\n")}` : "",
		volumes,
	};
};

// ─── Consul + Traefik Integration ────────────────────────────────────────────

/**
 * Generate one Consul service block per port.
 * - If a Nomploy domain targets this service+port, add Traefik tags
 * - Otherwise, register for inter-service discovery only
 */
const generateConsulServices = (
	appName: string,
	service: NomadServiceSpec,
	domains: Domain[],
	segmentation?: NomadSegmentation,
): string => {
	if (service.ports.length === 0) return "";

	const blocks = service.ports.map((port) => {
		const serviceName = `${appName}-${service.name}-${port.to}`;
		const isPrimary = port === service.ports[0];
		const inMesh = !!segmentation && isPrimary;
		// Mesh membership goes on the primary port only: transparent proxy protects
		// the whole alloc, and one sidecar per group keeps intentions keyed to a
		// single service identity.
		const connectBlock = inMesh
			? `\n      connect {
        sidecar_service {
          proxy {
            transparent_proxy {
              no_dns = true
            }
          }
        }
      }`
			: "";
		const portDomains = domains.filter(
			(d) =>
				d.serviceName === service.name &&
				(d.port === port.to || (!d.port && port === service.ports[0])),
		);

		const tags = generateConsulTags(appName, service.name, portDomains);
		// Tag the mesh service with its project so the intentions engine can group
		// services by project from a single Consul catalog listing (catalog returns
		// tags, not meta). Harmless to Traefik, which ignores non-traefik tags.
		const allTags = inMesh
			? [...tags, `${NOMPLOY_PROJECT_TAG}${segmentation.projectId}`]
			: tags;
		const tagsStr =
			allTags.length > 0
				? `\n      tags = [\n${allTags.map((t) => `        ${JSON.stringify(t)},`).join("\n")}\n      ]`
				: "";

		const checkBlock =
			service.healthCheck && port === service.ports[0]
				? `\n\n      check {
        type     = "${service.healthCheck.type}"
        path     = ${JSON.stringify(service.healthCheck.path || "/")}
        interval = "${service.healthCheck.interval}"
        timeout  = "${service.healthCheck.timeout}"
      }`
				: `\n\n      check {
        type     = "tcp"
        interval = "30s"
        timeout  = "5s"
      }`;

		// Mesh services advertise the alloc (pod) address. Without this the Connect
		// sidecar-to-sidecar hop dials the node's wg host IP + a bridge-mapped port
		// and Envoy's transparent original-source binding dies on the NAT hairpin
		// (same-node) / non-routable pod source (cross-node). address_mode=alloc
		// makes that hop use a routable source, so the mesh works both same-node
		// (direct bridge) and cross-node (over the WireGuard mesh).
		const addressModeLine = inMesh ? '\n      address_mode = "alloc"' : "";
		return `    service {
      name     = "${serviceName}"
      port     = "${port.label}"
      provider = "consul"${addressModeLine}${connectBlock}${tagsStr}${checkBlock}
    }`;
	});

	return blocks.join("\n\n");
};

/**
 * Generate Traefik-compatible Consul tags for a specific port's domains
 */
const generateConsulTags = (
	appName: string,
	serviceName: string,
	domains: Domain[],
): string[] => {
	if (domains.length === 0) return [];

	const tags: string[] = ["traefik.enable=true"];

	for (const domain of domains) {
		const routerName = `${appName}-${serviceName}-${domain.uniqueConfigKey}`;
		const pathRule =
			domain.path && domain.path !== "/"
				? ` && PathPrefix(\`${domain.path}\`)`
				: "";

		// HTTP router
		tags.push(
			`traefik.http.routers.${routerName}.rule=Host(\`${domain.host}\`)${pathRule}`,
			`traefik.http.routers.${routerName}.entrypoints=web`,
		);

		// HTTPS router
		if (domain.https) {
			const secureRouter = `${routerName}-secure`;
			tags.push(
				`traefik.http.routers.${secureRouter}.rule=Host(\`${domain.host}\`)${pathRule}`,
				`traefik.http.routers.${secureRouter}.entrypoints=websecure`,
				`traefik.http.routers.${secureRouter}.tls.certresolver=${domain.customCertResolver || "letsencrypt"}`,
			);
		}
	}

	return tags;
};
