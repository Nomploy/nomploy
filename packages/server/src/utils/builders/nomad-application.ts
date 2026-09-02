import { join } from "node:path";
import { paths } from "@nomploy/server/constants";
import type { Domain } from "@nomploy/server/services/domain";
import { getRegistryTag } from "../cluster/upload";
import { encodeBase64, getEnvironmentVariablesObject } from "../docker/utils";
import type { ApplicationNested } from "./index";
import { generateNomadJobSpec, type NomadServiceSpec } from "./nomad";

// A Dokploy application is a single service. We give its Nomad group a stable
// name so domains (whose serviceName is set to this) and the Consul service key
// line up with what Traefik expects.
export const NOMAD_APP_SERVICE_NAME = "app";

/**
 * Resolve the image Nomad should run. For built sources the image must live in a
 * registry so any node in the cluster can pull it (Swarm could rely on a locally
 * built image; a multi-node Nomad cluster cannot). Docker-source apps use their
 * image directly.
 */
export const resolveApplicationImage = (
	application: ApplicationNested,
): string => {
	if (application.sourceType === "docker") {
		return application.dockerImage || "ERROR-NO-IMAGE-PROVIDED";
	}
	const imageName = `${application.appName}:latest`;
	if (application.registry)
		return getRegistryTag(application.registry, imageName);
	if (application.buildRegistry)
		return getRegistryTag(application.buildRegistry, imageName);
	// No registry: only reachable on the node that built it (single-node).
	return imageName;
};

/**
 * Map an application (its Swarm-era fields) onto a single Nomad service spec,
 * reusing the compose builder's HCL generation.
 */
export const applicationToNomadSpec = (
	application: ApplicationNested,
): NomadServiceSpec => {
	const env = getEnvironmentVariablesObject(
		application.env,
		application.environment.project.env,
		application.environment.env,
	);

	// Swarm stored NanoCPUs (1 core = 1e9) and bytes; Nomad wants MHz (1 core =
	// 1000 MHz, matching the compose builder) and MB.
	const cpu = application.cpuLimit
		? Math.round(Number.parseInt(application.cpuLimit) / 1_000_000)
		: undefined;
	const memory = application.memoryLimit
		? Math.round(Number.parseInt(application.memoryLimit) / (1024 * 1024))
		: undefined;

	const ports = (application.ports || []).map((p) => ({
		label: `port${p.targetPort}`,
		to: p.targetPort,
		protocol: p.protocol as "tcp" | "udp" | undefined,
	}));

	const entrypoint = [
		...(application.command
			? application.command.split(" ").filter(Boolean)
			: []),
		...(((application.args as string[] | null) ?? []) as string[]),
	];

	return {
		name: NOMAD_APP_SERVICE_NAME,
		image: resolveApplicationImage(application),
		ports,
		replicas: application.replicas ?? 1,
		env,
		entrypoint: entrypoint.length > 0 ? entrypoint : undefined,
		resources: cpu || memory ? { cpu, memory } : undefined,
	};
};

/**
 * The HCL job for an application. Domains must already carry serviceName ===
 * NOMAD_APP_SERVICE_NAME so the Consul/Traefik tags attach to this service.
 */
export const generateApplicationNomadJob = (
	application: ApplicationNested,
	domains: Domain[],
): string =>
	generateNomadJobSpec(
		application.appName,
		[applicationToNomadSpec(application)],
		domains,
	);

/**
 * Deploy script fragment: push the freshly built image to its registry (built
 * sources only — docker-source images are already remote), write the HCL job,
 * and submit it to Nomad. `getBuildCommand` has already built the image before
 * this runs, mirroring the compose deploy pipeline.
 */
export const getBuildNomadApplicationCommand = (
	application: ApplicationNested,
	domains: Domain[],
): string => {
	const { APPLICATIONS_PATH } = paths(!!application.serverId);
	const projectPath = join(APPLICATIONS_PATH, application.appName, "code");
	const jobFilePath = join(projectPath, `${application.appName}.nomad.hcl`);
	const image = resolveApplicationImage(application);
	const jobSpec = generateApplicationNomadJob(application, domains);
	const encoded = encodeBase64(jobSpec);

	const needsPush =
		application.sourceType !== "docker" &&
		(application.registry || application.buildRegistry);

	return `
set -e
{
	mkdir -p "${projectPath}"
	echo "${encoded}" | base64 -d > "${jobFilePath}"
	echo "Nomad job file written: ✅"
${
	needsPush
		? `	docker push "${image}" 2>&1
	echo "Image pushed to registry: ✅"
`
		: ""
}	nomad job run "${jobFilePath}" 2>&1
	echo "Nomad Job Deployed: ✅"
} || {
	echo "Error: ❌ Nomad deployment failed"
	exit 1
}
`;
};
