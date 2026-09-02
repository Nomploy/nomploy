import { parse } from "yaml";
import type { Domain } from "@nomploy/server/services/domain";
import type {
	ComposeSpecification,
	DefinitionsService,
} from "../docker/types";
import type { NomadComposeNested, NomadServiceSpec, NomadPort } from "./nomad";
import { getEnvironmentVariablesObject } from "../docker/utils";

/**
 * Parse a docker-compose YAML string into Nomad service specs.
 * Resolves ${VAR} references using the provided env vars.
 */
export const parseComposeToNomadServices = (
	composeFile: string,
	envVars: Record<string, string>,
): NomadServiceSpec[] => {
	// Substitute ${VAR} in the YAML before parsing
	const substituted = substituteEnvVars(composeFile, envVars);
	const spec = parse(substituted, { maxAliasCount: 10000 }) as ComposeSpecification;

	if (!spec?.services) {
		throw new Error("No services found in compose file");
	}

	return Object.entries(spec.services).map(([name, service]) =>
		convertService(name, service, envVars),
	);
};

/**
 * Convert a single Docker Compose service to a Nomad service spec
 */
const convertService = (
	name: string,
	service: DefinitionsService,
	envVars: Record<string, string>,
): NomadServiceSpec => {
	const image = service.image || name;
	const ports = extractPorts(service);
	const replicas = service.deploy?.replicas || 1;
	const env = resolveServiceEnvironment(service, envVars);
	const entrypoint = extractEntrypoint(service);
	const healthCheck = extractHealthCheck(service);
	const resources = extractResources(service);
	const scaling = extractScaling(service);

	return {
		name,
		image,
		ports,
		replicas,
		env,
		entrypoint,
		healthCheck,
		resources,
		scaling,
	};
};

/**
 * Resolve environment variables for a service.
 * Handles both list format (- KEY=VALUE) and mapping format (KEY: VALUE).
 * Substitutes ${VAR} references from the provided envVars.
 */
const resolveServiceEnvironment = (
	service: DefinitionsService,
	envVars: Record<string, string>,
): Record<string, string> => {
	const env: Record<string, string> = {};

	if (!service.environment) return env;

	if (Array.isArray(service.environment)) {
		for (const item of service.environment) {
			const str = String(item);
			const eqIndex = str.indexOf("=");
			if (eqIndex > 0) {
				const key = str.substring(0, eqIndex);
				const value = str.substring(eqIndex + 1);
				env[key] = value;
			}
		}
	} else {
		for (const [key, value] of Object.entries(service.environment)) {
			if (key === "<<") {
				// Merge key — flatten the referenced values
				if (value && typeof value === "object") {
					for (const [k, v] of Object.entries(value)) {
						env[k] = String(v ?? "");
					}
				}
			} else {
				env[key] = String(value ?? "");
			}
		}
	}

	return env;
};

/**
 * Extract all ports from a service definition.
 * Returns array of NomadPort with label, container port, and protocol.
 */
const extractPorts = (service: DefinitionsService): NomadPort[] => {
	const ports: NomadPort[] = [];

	if (service.ports) {
		for (const port of service.ports) {
			if (typeof port === "number") {
				ports.push({ label: `port-${port}`, to: port });
			} else if (typeof port === "string") {
				// "80", "8080:80", "80/tcp", "80/udp"
				const match = port.match(/(?:.*:)?(\d+)(?:\/(tcp|udp))?/);
				if (match?.[1]) {
					const num = parseInt(match[1], 10);
					const protocol = match[2] as "tcp" | "udp" | undefined;
					ports.push({ label: `port-${num}`, to: num, protocol });
				}
			} else if (typeof port === "object" && "target" in port) {
				const target = port.target as number;
				const protocol = (port as Record<string, unknown>).protocol as "tcp" | "udp" | undefined;
				ports.push({ label: `port-${target}`, to: target, protocol });
			}
		}
	}

	if (ports.length === 0 && service.expose) {
		for (const exp of service.expose) {
			const num = typeof exp === "number" ? exp : parseInt(String(exp), 10);
			if (!isNaN(num)) {
				ports.push({ label: `port-${num}`, to: num });
			}
		}
	}

	return ports;
};

/**
 * Extract entrypoint as string array
 */
const extractEntrypoint = (service: DefinitionsService): string[] | undefined => {
	if (!service.entrypoint) return undefined;
	if (typeof service.entrypoint === "string") {
		return service.entrypoint.split(/\s+/);
	}
	return service.entrypoint;
};

/**
 * Convert Docker healthcheck to Nomad check format
 */
const extractHealthCheck = (
	service: DefinitionsService,
): NomadServiceSpec["healthCheck"] => {
	if (!service.healthcheck || service.healthcheck.disable) return undefined;

	const test = service.healthcheck.test;
	let type = "tcp";
	let path: string | undefined;

	if (test) {
		const testArr = Array.isArray(test) ? test : [test];
		const testStr = testArr.join(" ");

		if (testStr.includes("curl") || testStr.includes("wget")) {
			type = "http";
			const urlMatch = testStr.match(/https?:\/\/[^/]+(\/[^\s"]*)/);
			path = urlMatch ? urlMatch[1] : "/";
		}
	}

	return {
		type,
		path,
		interval: service.healthcheck.interval || "30s",
		timeout: service.healthcheck.timeout || "10s",
	};
};

/**
 * Extract resource limits from deploy config
 */
const extractResources = (
	service: DefinitionsService,
): NomadServiceSpec["resources"] => {
	const deploy = service.deploy;
	if (!deploy) return undefined;

	// @ts-ignore - resources might exist in deploy
	const resources = deploy.resources;
	if (!resources) return undefined;

	const limits = resources.limits;
	if (!limits) return undefined;

	let cpu: number | undefined;
	let memory: number | undefined;

	if (limits.cpus) {
		// Docker uses fractional CPUs (e.g., "0.5"), Nomad uses MHz
		cpu = Math.round(parseFloat(String(limits.cpus)) * 1000);
	}

	if (limits.memory) {
		// Docker uses "512M", "1G" etc, Nomad uses MB
		memory = parseMemoryToMB(String(limits.memory));
	}

	return { cpu, memory };
};

/**
 * Extract autoscaling config from x-nomad-scaling extension.
 * Example:
 *   x-nomad-scaling:
 *     min: 1
 *     max: 10
 *     cpu_target: 70
 *     memory_target: 80
 *     cooldown: "2m"
 *     evaluation_interval: "30s"
 */
const extractScaling = (
	service: DefinitionsService,
): NomadServiceSpec["scaling"] => {
	const scaling = (service as Record<string, unknown>)["x-nomad-scaling"] as
		| { min?: number; max?: number; cpu_target?: number; memory_target?: number; cooldown?: string; evaluation_interval?: string }
		| undefined;
	if (!scaling) return undefined;

	return {
		min: scaling.min ?? 1,
		max: scaling.max ?? 10,
		cpuTarget: scaling.cpu_target,
		memoryTarget: scaling.memory_target,
		cooldown: scaling.cooldown,
		evaluationInterval: scaling.evaluation_interval,
	};
};

/**
 * Parse memory string (512M, 1G, 256m) to MB
 */
const parseMemoryToMB = (mem: string): number => {
	const match = mem.match(/^(\d+(?:\.\d+)?)\s*([gmkGMK])?[bB]?$/);
	if (!match?.[1]) return 512;

	const value = parseFloat(match[1]);
	const unit = (match[2] || "m").toLowerCase();

	switch (unit) {
		case "g":
			return Math.round(value * 1024);
		case "k":
			return Math.round(value / 1024);
		default:
			return Math.round(value);
	}
};

/**
 * Substitute ${VAR} and $VAR references in a string with env values.
 * Mimics Docker Compose variable interpolation.
 */
const substituteEnvVars = (
	content: string,
	envVars: Record<string, string>,
): string => {
	return content.replace(
		/\$\{([^}:]+?)(?::?-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(match, braced, bare) => {
			const varName = braced || bare;
			return envVars[varName] ?? "";
		},
	);
};
