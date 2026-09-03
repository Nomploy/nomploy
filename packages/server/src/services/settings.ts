import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	execAsync,
	execAsyncRemote,
} from "@nomploy/server/utils/process/execAsync";
import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { compose } from "../db/schema";
import {
	initializeStandaloneTraefik,
	initializeTraefikService,
	type TraefikOptions,
} from "../setup/traefik-setup";
import {
	collectPanelEnv,
	getPanelNomadDeployCommand,
	PANEL_JOB_NAME,
	resolvePanelImage,
} from "../utils/builders/nomad-panel";
export interface IUpdateData {
	latestVersion: string | null;
	updateAvailable: boolean;
}

export const DEFAULT_UPDATE_DATA: IUpdateData = {
	latestVersion: null,
	updateAvailable: false,
};

/** Returns current Nomploy docker image tag or `latest` by default. */
export const getNomployImageTag = () => {
	return process.env.RELEASE_TAG || "latest";
};

/**
 * Parse an image reference into registry / repository / tag.
 * "ghcr.io/nomploy/nomploy:latest" -> { registry, repository: "nomploy/nomploy",
 * tag: "latest" }. A ":" before the first "/" is a registry port, not a tag.
 */
const parseImageRef = (ref: string) => {
	let rest = ref;
	let tag = "latest";
	const lastColon = rest.lastIndexOf(":");
	const lastSlash = rest.lastIndexOf("/");
	if (lastColon > lastSlash) {
		tag = rest.slice(lastColon + 1);
		rest = rest.slice(0, lastColon);
	}
	const firstSlash = rest.indexOf("/");
	const maybeRegistry = firstSlash === -1 ? "" : rest.slice(0, firstSlash);
	const hasRegistry =
		maybeRegistry.includes(".") || maybeRegistry.includes(":");
	const registry = hasRegistry ? maybeRegistry : "registry-1.docker.io";
	const repository = hasRegistry ? rest.slice(firstSlash + 1) : rest;
	return { registry, repository, tag };
};

/** The digest the local image for `ref` was pulled at (its RepoDigest), or null. */
const getLocalImageDigest = async (ref: string): Promise<string | null> => {
	try {
		const { stdout } = await execAsync(
			`docker image inspect ${ref} --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}'`,
		);
		const digest = stdout.trim().split("@")[1];
		return digest || null;
	} catch {
		return null;
	}
};

/**
 * The current manifest digest of `registry/repository:tag` from the registry v2
 * API, following the standard WWW-Authenticate bearer-token challenge (works for
 * GHCR's anonymous pull token on a public package, and Docker Hub, etc.).
 */
const getRemoteManifestDigest = async (
	registry: string,
	repository: string,
	tag: string,
): Promise<string | null> => {
	const url = `https://${registry}/v2/${repository}/manifests/${tag}`;
	const accept = [
		"application/vnd.oci.image.index.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.v2+json",
	].join(", ");
	const fetchManifest = (token?: string) =>
		fetch(url, {
			method: "GET",
			headers: {
				Accept: accept,
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
		});

	let res = await fetchManifest();
	if (res.status === 401) {
		const challenge = res.headers.get("www-authenticate") || "";
		const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
		const service = /service="([^"]+)"/.exec(challenge)?.[1];
		const scope =
			/scope="([^"]+)"/.exec(challenge)?.[1] || `repository:${repository}:pull`;
		if (realm) {
			const tokenUrl = new URL(realm);
			if (service) tokenUrl.searchParams.set("service", service);
			tokenUrl.searchParams.set("scope", scope);
			const tokenRes = await fetch(tokenUrl.toString());
			const { token } = (await tokenRes.json()) as { token?: string };
			if (token) res = await fetchManifest(token);
		}
	}
	if (!res.ok) return null;
	return res.headers.get("docker-content-digest");
};

/**
 * Is a newer panel image available? Compares the digest the panel image
 * (NOMPLOY_IMAGE, e.g. ghcr.io/nomploy/nomploy:latest) was last pulled at
 * against that tag's current registry digest. A moving tag (:latest/:canary)
 * that advanced upstream reports an update; a pinned :sha-* never does.
 *
 * Replaces the old Docker Hub + `docker service inspect` (Swarm) check, neither
 * of which applies to the GHCR + Nomad deployment. The digest comparison is the
 * same signal the reload path acts on: force_pull fetches exactly this digest.
 */
export const getUpdateData = async (): Promise<IUpdateData> => {
	try {
		const imageRef =
			process.env.NOMPLOY_IMAGE || "ghcr.io/nomploy/nomploy:latest";
		const { registry, repository, tag } = parseImageRef(imageRef);
		const [localDigest, remoteDigest] = await Promise.all([
			getLocalImageDigest(imageRef),
			getRemoteManifestDigest(registry, repository, tag),
		]);
		if (!remoteDigest || !localDigest) return DEFAULT_UPDATE_DATA;
		const updateAvailable = localDigest !== remoteDigest;
		return {
			updateAvailable,
			latestVersion: updateAvailable
				? `${tag} (${remoteDigest.replace("sha256:", "").slice(0, 12)})`
				: null,
		};
	} catch (error) {
		console.error("Error fetching update data:", error);
		return DEFAULT_UPDATE_DATA;
	}
};

interface TreeDataItem {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TreeDataItem[];
}

export const readDirectory = async (
	dirPath: string,
	serverId?: string,
): Promise<TreeDataItem[]> => {
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			`
process_items() {
    local parent_dir="$1"
    local __resultvar=$2

    local items_json=""
    local first=true
    for item in "$parent_dir"/*; do
        [ -e "$item" ] || continue
        process_item "$item" item_json
        if [ "$first" = true ]; then
            first=false
            items_json="$item_json"
        else
            items_json="$items_json,$item_json"
        fi
    done

    eval $__resultvar="'[$items_json]'"
}

process_item() {
    local item_path="$1"
    local __resultvar=$2

    local item_name=$(basename "$item_path")
    local escaped_name=$(echo "$item_name" | sed 's/"/\\"/g')
    local escaped_path=$(echo "$item_path" | sed 's/"/\\"/g')

    if [ -d "$item_path" ]; then
        # Is directory
        process_items "$item_path" children_json
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"directory","children":'"$children_json"'}'
    else
        # Is file
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"file"}'
    fi

    eval $__resultvar="'$json'"
}

root_dir=${dirPath}

process_items "$root_dir" json_output

echo "$json_output"
			`,
		);
		const result = JSON.parse(stdout);
		return result;
	}

	const stack = [dirPath];
	const result: TreeDataItem[] = [];
	const parentMap: Record<string, TreeDataItem[]> = {};

	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) continue;

		const items = readdirSync(currentPath, { withFileTypes: true });
		const currentDirectoryResult: TreeDataItem[] = [];

		for (const item of items) {
			const fullPath = join(currentPath, item.name);
			if (item.isDirectory()) {
				stack.push(fullPath);
				const directoryItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "directory",
					children: [],
				};
				currentDirectoryResult.push(directoryItem);
				parentMap[fullPath] = directoryItem.children as TreeDataItem[];
			} else {
				const fileItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "file",
				};
				currentDirectoryResult.push(fileItem);
			}
		}

		if (parentMap[currentPath]) {
			parentMap[currentPath].push(...currentDirectoryResult);
		} else {
			result.push(...currentDirectoryResult);
		}
	}
	return result;
};

export const getDockerResourceType = async (
	resourceName: string,
	serverId?: string,
) => {
	try {
		let result = "";
		const command = `
RESOURCE_NAME="${resourceName}"
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`;

		if (serverId) {
			const { stdout } = await execAsyncRemote(serverId, command);
			result = stdout.trim();
		} else {
			const { stdout } = await execAsync(command);
			result = stdout.trim();
		}
		if (result === "service") {
			return "service";
		}
		if (result === "standalone") {
			return "standalone";
		}
		return "unknown";
	} catch (error) {
		console.error(error);
		return "unknown";
	}
};

export const reloadDockerResource = async (
	resourceName: string,
	serverId?: string,
) => {
	// The panel runs as a Nomad job named "nomploy" (its container is
	// nomploy-<allocId>, so it isn't a plain service/standalone). Self-update the
	// Dokploy way: re-submit the job with the resolved image. `nomad job run`
	// pulls it and rolling-restarts the allocation in place — the Nomad
	// equivalent of Swarm's `docker service update --image`.
	if (resourceName === PANEL_JOB_NAME) {
		// Reload the panel on its CURRENT image (NOMPLOY_IMAGE); force_pull in the
		// job re-pulls a moving tag (:latest/:canary) to its newest digest. We
		// deliberately don't map `version` (packageInfo.version, e.g. v0.29.7) to a
		// tag — those release tags aren't published to the registry (only :latest
		// and :sha-*), so doing so fails the image pull.
		const image = resolvePanelImage();
		const command = getPanelNomadDeployCommand(image, collectPanelEnv());
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
		return;
	}

	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service update --force ${resourceName}`;
	} else if (resourceType === "standalone") {
		command = `docker restart ${resourceName}`;
	} else {
		throw new Error("Resource type not found");
	}
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const readEnvironmentVariables = async (
	resourceName: string,
	serverId?: string,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .Config.Env}}'`;
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}
	if (result === "null") {
		return "";
	}
	return JSON.parse(result)?.join("\n");
};

export const readPorts = async (
	resourceName: string,
	serverId?: string,
): Promise<
	{ targetPort: number; publishedPort: number; protocol?: string }[]
> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.EndpointSpec.Ports}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .NetworkSettings.Ports}}'`;
	} else {
		throw new Error("Resource type not found");
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}

	if (result === "null") {
		return [];
	}

	const parsedResult = JSON.parse(result);

	if (resourceType === "service") {
		return parsedResult
			.map((port: any) => ({
				targetPort: port.TargetPort,
				publishedPort: port.PublishedPort,
				protocol: port.Protocol,
			}))
			.filter((port: any) => port.targetPort !== 80 && port.targetPort !== 443);
	}
	const ports: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[] = [];
	const seenPorts = new Set<string>();
	for (const key in parsedResult) {
		if (Object.hasOwn(parsedResult, key)) {
			const containerPortMappings = parsedResult[key];
			const protocol = key.split("/")[1];
			const targetPort = Number.parseInt(key.split("/")[0] ?? "0", 10);

			// Take only the first mapping to avoid duplicates (IPv4 and IPv6)
			const firstMapping = containerPortMappings[0];
			if (firstMapping) {
				const publishedPort = Number.parseInt(firstMapping.HostPort, 10);
				const portKey = `${targetPort}-${publishedPort}-${protocol}`;
				if (!seenPorts.has(portKey)) {
					seenPorts.add(portKey);
					ports.push({
						targetPort: targetPort,
						publishedPort: publishedPort,
						protocol: protocol,
					});
				}
			}
		}
	}
	return ports.filter(
		(port: any) => port.targetPort !== 80 && port.targetPort !== 443,
	);
};

export const checkPortInUse = async (
	port: number,
	serverId?: string,
): Promise<{ isInUse: boolean; conflictingContainer?: string }> => {
	try {
		// Check if port is in use by a Docker container
		const dockerCommand = `docker ps -a --format '{{.Names}}' | grep -v '^nomploy-traefik$' | while read name; do docker port "$name" 2>/dev/null | grep -q ':${port}' && echo "$name" && break; done || true`;
		const { stdout: dockerOut } = serverId
			? await execAsyncRemote(serverId, dockerCommand)
			: await execAsync(dockerCommand);

		const container = dockerOut.trim();

		if (container) {
			return {
				isInUse: true,
				conflictingContainer: `container "${container}"`,
			};
		}

		// Check if port is in use by a host-level service (non-Docker)
		// Nomploy runs inside a container, so we spawn an ephemeral container
		// with --net=host to share the host's network stack and use nc -z to
		// check if something is listening on the port
		const hostCommand = `docker run --rm --net=host busybox sh -c 'nc -z 0.0.0.0 ${port} 2>/dev/null && echo in_use || echo free'`;
		const { stdout: hostOut } = serverId
			? await execAsyncRemote(serverId, hostCommand)
			: await execAsync(hostCommand);

		if (hostOut.includes("in_use")) {
			return {
				isInUse: true,
				conflictingContainer: "a host-level service",
			};
		}

		return { isInUse: false };
	} catch (error) {
		console.error("Error checking port availability:", error);
		return { isInUse: false };
	}
};

export const writeTraefikSetup = async (input: TraefikOptions) => {
	const resourceType = await getDockerResourceType(
		"nomploy-traefik",
		input.serverId,
	);

	if (resourceType === "service") {
		await initializeTraefikService({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});
		await reconnectServicesToTraefik(input.serverId);
	} else if (resourceType === "standalone") {
		await initializeStandaloneTraefik({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});

		await reconnectServicesToTraefik(input.serverId);
	} else {
		throw new Error("Traefik resource type not found");
	}
};

export const reconnectServicesToTraefik = async (serverId?: string) => {
	const composeResult = await db.query.compose.findMany({
		where: and(
			...(serverId ? [eq(compose.serverId, serverId)] : []),
			eq(compose.isolatedDeployment, true),
		),
	});

	if (!composeResult) {
		return;
	}
	let commands = "";

	for (const compose of composeResult) {
		commands += `docker network connect ${compose.appName} $(docker ps --filter "name=nomploy-traefik" -q) >/dev/null 2>&1\n`;
	}

	if (serverId) {
		await execAsyncRemote(serverId, commands);
	} else {
		await execAsync(commands);
	}
};
