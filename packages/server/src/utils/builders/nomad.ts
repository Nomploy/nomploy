import { join } from "node:path";
import { paths } from "@nomploy/server/constants";
import type { Domain } from "@nomploy/server/services/domain";
import type { InferResultType } from "@nomploy/server/types/with";
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

	// Resolve all env vars (project + environment + service)
	const envVars = resolveNomadEnvVars(compose);

	// Parse compose file into Nomad services
	const services = parseComposeToNomadServices(composeFile, envVars);

	// Generate Nomad HCL job spec
	const jobSpec = generateNomadJobSpec(appName, services, domains);
	const encodedJobSpec = encodeBase64(jobSpec);

	return `
set -e
{
	cd "${projectPath}"

	# Write Nomad job file
	echo "${encodedJobSpec}" | base64 -d > "${jobFilePath}"
	echo "Nomad job file written: \u2705"

	# Build Docker image
	docker compose build 2>&1
	echo "Docker image built: \u2705"

	# Push to registry
	docker compose push 2>&1
	echo "Docker image pushed: \u2705"

	# Deploy to Nomad
	nomad job run "${jobFilePath}" 2>&1
	echo "Nomad Job Deployed: \u2705"
} || {
	echo "Error: \u274c Nomad deployment failed"
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
const generateNomadJobSpec = (
	appName: string,
	services: NomadServiceSpec[],
	domains: Domain[],
): string => {
	const taskGroups = services
		.map((service) => generateTaskGroup(appName, service, domains))
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
): string => {
	const envBlock = generateEnvBlock(service.env);
	const consulServices = generateConsulServices(appName, service, domains);
	const resourcesBlock = generateResourcesBlock(service.resources);
	const scalingBlock = generateScalingBlock(service.scaling);
	const entrypointLine = service.entrypoint
		? `\n        entrypoint = ${JSON.stringify(service.entrypoint)}`
		: "";

	const hasPorts = service.ports.length > 0;
	const networkBlock = hasPorts
		? `    network {
${service.ports
	.map(
		(p) => `      port "${p.label}" {
        to = ${p.to}
      }`,
	)
	.join("\n")}
    }`
		: "";
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
${scalingBlock}${
	hasPorts
		? `${networkBlock}

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
	return `      resources {
        cpu    = ${resources?.cpu || 256}
        memory = ${resources?.memory || 512}
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
): string => {
	if (service.ports.length === 0) return "";

	const blocks = service.ports.map((port) => {
		const serviceName = `${appName}-${service.name}-${port.to}`;
		const portDomains = domains.filter(
			(d) =>
				d.serviceName === service.name &&
				(d.port === port.to || (!d.port && port === service.ports[0])),
		);

		const tags = generateConsulTags(appName, service.name, port, portDomains);
		const tagsStr =
			tags.length > 0
				? `\n      tags = [\n${tags.map((t) => `        ${JSON.stringify(t)},`).join("\n")}\n      ]`
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

		return `    service {
      name     = "${serviceName}"
      port     = "${port.label}"
      provider = "consul"${tagsStr}${checkBlock}
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
	port: NomadPort,
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
