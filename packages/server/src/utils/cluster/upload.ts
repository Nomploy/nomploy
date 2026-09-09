import { findAllDeploymentsByApplicationId } from "@nomploy/server/services/deployment";
import type { Registry } from "@nomploy/server/services/registry";
import { createRollback } from "@nomploy/server/services/rollbacks";
import type { ApplicationNested } from "../builders";

export const uploadImageRemoteCommand = async (
	application: ApplicationNested,
) => {
	const registry = application.registry;
	const buildRegistry = application.buildRegistry;
	const rollbackRegistry = application.rollbackRegistry;

	if (!registry && !buildRegistry && !rollbackRegistry) {
		throw new Error("No registry found");
	}

	const { appName } = application;
	const imageName =
		application.sourceType === "docker"
			? application.dockerImage || ""
			: `${appName}:latest`;

	const commands: string[] = [];
	if (registry) {
		const registryTag = getRegistryTag(registry, imageName);
		if (registryTag) {
			commands.push(`echo "📦 [Enabled Registry Swarm]"`);
			commands.push(getRegistryCommands(registry, imageName, registryTag));
		}
	}
	if (buildRegistry) {
		const buildRegistryTag = getRegistryTag(buildRegistry, imageName);
		if (buildRegistryTag) {
			commands.push(`echo "🔑 [Enabled Build Registry]"`);
			commands.push(
				getRegistryCommands(buildRegistry, imageName, buildRegistryTag),
			);
			commands.push(
				`echo "⚠️ INFO: After the build is finished, you need to wait a few seconds for the server to download the image and run the container."`,
			);
			commands.push(
				`echo "📊 Check the Logs tab to see when the container starts running."`,
			);
		}
	}

	if (rollbackRegistry && application.rollbackActive) {
		const deployment = await findAllDeploymentsByApplicationId(
			application.applicationId,
		);
		if (!deployment || !deployment[0]) {
			throw new Error("Deployment not found");
		}
		const deploymentId = deployment[0].deploymentId;
		const rollback = await createRollback({
			appName: appName,
			deploymentId: deploymentId,
		});

		const rollbackRegistryTag = getRegistryTag(
			rollbackRegistry,
			rollback?.image || "",
		);
		if (rollbackRegistryTag) {
			commands.push(`echo "🔄 [Enabled Rollback Registry]"`);
			commands.push(
				getRegistryCommands(rollbackRegistry, imageName, rollbackRegistryTag),
			);
		}
	}
	try {
		return commands.join("\n");
	} catch (error) {
		throw error;
	}
};
/**
 * Extract the repository name from imageName by taking the last part after '/'
 * Examples:
 * - "nginx" -> "nginx"
 * - "nginx:latest" -> "nginx:latest"
 * - "myuser/myrepo" -> "myrepo"
 * - "myuser/myrepo:tag" -> "myrepo:tag"
 * - "docker.io/myuser/myrepo" -> "myrepo"
 */
const extractRepositoryName = (imageName: string): string => {
	const lastSlashIndex = imageName.lastIndexOf("/");

	// If no '/', return the imageName as is
	if (lastSlashIndex === -1) {
		return imageName;
	}

	// Extract everything after the last '/'
	return imageName.substring(lastSlashIndex + 1);
};

/**
 * Slugify a project name for use as a registry path segment
 * (<host>/<project-slug>/<image>). Falls back to "project" when empty.
 */
export const projectSlug = (name?: string | null): string =>
	(name || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "project";

export const getRegistryTag = (
	registry: Registry,
	imageName: string,
	// Overrides the registry's imagePrefix — used to namespace built-in-registry
	// images by project (<host>/<project-slug>/<image>).
	pathPrefixOverride?: string,
) => {
	const { registryUrl, imagePrefix, username } = registry;

	// Extract the repository name (last part after '/')
	const repositoryName = extractRepositoryName(imageName);

	// Build the final tag using the project slug (built-in) or registry's
	// prefix/username (must be lowercase for valid image refs).
	const targetPrefix = (
		pathPrefixOverride ||
		imagePrefix ||
		username
	).toLowerCase();
	const finalRegistry = registryUrl || "";

	return finalRegistry
		? `${finalRegistry}/${targetPrefix}/${repositoryName}`
		: `${targetPrefix}/${repositoryName}`;
};

const getRegistryCommands = (
	registry: Registry,
	imageName: string,
	registryTag: string,
): string => {
	return `
echo "📦 [Enabled Registry] Uploading image to '${registry.registryType}' | '${registryTag}'" ;
echo "${registry.password}" | docker login ${registry.registryUrl} -u '${registry.username}' --password-stdin || { 
	echo "❌ DockerHub Failed" ;
	exit 1;
}
echo "✅ Registry Login Success" ;
docker tag ${imageName} ${registryTag} || { 
	echo "❌ Error tagging image" ;
	exit 1;
}
echo "✅ Image Tagged" ;
docker push ${registryTag} || { 
	echo "❌ Error pushing image" ;
	exit 1;
}
	echo "✅ Image Pushed" ;
`;
};
