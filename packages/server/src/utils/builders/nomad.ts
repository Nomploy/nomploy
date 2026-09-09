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
		memory?: number;
		/** Number of NVIDIA GPUs to request (nomad-device-nvidia). */
		gpus?: number;
	};
	scaling?: {
		min: number;
		max: number;
		cpuTarget?: number;
		memoryTarget?: number;
		cooldown?: string;
		evaluationInterval?: string;
	};
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
		jobSpec = generateNomadJobSpec(appName, services, domains, segmentation);
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
} || {
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
	// referenced with --registry. Tolerate a non-zero exit so re-deploys (where
	// the registry already exists) don't fail.
	const registryName = "nomploy-custom";
	const addRegistry = nomadPackRegistry
		? `\tnomad-pack registry add ${registryName} "${nomadPackRegistry}" 2>&1 || true\n`
		: "";
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
} || {
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

export const generateNomadJobSpec = (
	appName: string,
	services: NomadServiceSpec[],
	domains: Domain[],
	segmentation?: NomadSegmentation,
): string => {
	const taskGroups = services
		.map((service) =>
			generateTaskGroup(appName, service, domains, segmentation),
		)
		.join("\n\n");

	return `job "${appName}" {
  namespace = "default"
  type      = "service"

  update {
    max_parallel     = 1
    health_check     = "checks"
    min_healthy_time = "10s"
    healthy_deadline = "5m"
    auto_revert      = true
  }

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
        image = "${service.image}"${portsConfig}${entrypointLine}
      }

${envBlock}

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
	return `      resources {
        cpu    = ${resources?.cpu || 256}
        memory = ${resources?.memory || 512}${gpuBlock}
      }`;
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
