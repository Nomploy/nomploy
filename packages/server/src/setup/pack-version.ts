import { paths } from "../constants";
import type { compose as composeTable } from "../db/schema";
import { encodeBase64 } from "../utils/docker/utils";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";

type Compose = typeof composeTable.$inferSelect;

// Where a pack without a custom registry comes from.
const COMMUNITY = "github.com/hashicorp/nomad-pack-community-registry";

const asUrl = (u: string) => (u.startsWith("http") ? u : `https://${u}`);
const safeRef = (r: string) => r.replace(/[^A-Za-z0-9._/-]/g, "");

/** The git registry a pack deploys from (custom URL, else the community one). */
export const packRegistryUrl = (
	c: Pick<Compose, "nomadPackRegistry">,
): string => c.nomadPackRegistry?.trim() || COMMUNITY;

// The local alias `nomad-pack registry add` uses (mirrors builders/nomad.ts).
const registryName = (c: Pick<Compose, "nomadPackRegistry">): string =>
	c.nomadPackRegistry ? "nomploy-custom" : "default";

// Pack commands run where nomad-pack + git live: the control plane (panel
// container) for control-plane composes, else the target server.
const run = async (
	serverId: string | null | undefined,
	cmd: string,
): Promise<string> => {
	const { stdout } = serverId
		? await execAsyncRemote(serverId, cmd)
		: await execAsync(cmd);
	return stdout ?? "";
};

/**
 * The registry's current HEAD commit SHA — the "latest" ref an upgrade would
 * move to. Null when it can't be resolved. Compare to the compose's pinned
 * `nomadPackRef` to decide whether an upgrade is available.
 */
export const resolvePackHeadRef = async (
	compose: Pick<Compose, "nomadPackRegistry" | "serverId">,
): Promise<string | null> => {
	try {
		const out = await run(
			compose.serverId,
			`git ls-remote ${asUrl(packRegistryUrl(compose))} HEAD 2>/dev/null | head -1`,
		);
		const sha = out.trim().split(/\s+/)[0] ?? "";
		return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
	} catch {
		return null;
	}
};

/**
 * Unified diff of the pack's RENDERED Nomad job between two registry refs — the
 * "preview changes" for an upgrade. Renders the pack (with the compose's stored
 * variables) at each ref and `diff -u`s them. Empty string = no differences.
 */
export const renderPackDiff = async (
	compose: Pick<
		Compose,
		"nomadPack" | "nomadPackRegistry" | "serverId" | "composeFile" | "appName"
	>,
	fromRef: string,
	toRef: string,
): Promise<string> => {
	const pack = compose.nomadPack;
	if (!pack) return "";
	const name = registryName(compose);
	const url = asUrl(packRegistryUrl(compose));
	const from = safeRef(fromRef);
	const to = safeRef(toRef);
	if (!from || !to) return "";
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const vf = `${COMPOSE_PATH}/${compose.appName}/code/${compose.appName}.upgrade.vars.hcl`;
	const hasVars =
		!!compose.composeFile && compose.composeFile.trim().length > 0;
	const encVars = encodeBase64(compose.composeFile || "");
	const varFlag = hasVars ? ` --var-file="${vf}"` : "";
	// set +e: `diff -u` exits 1 when files differ — that's expected, not an error.
	const cmd = `
set +e
${hasVars ? `mkdir -p "$(dirname "${vf}")"; echo "${encVars}" | base64 -d > "${vf}"` : ""}
nomad-pack registry add ${name} "${url}" --ref ${from} >/dev/null 2>&1
nomad-pack registry add ${name} "${url}" --ref ${to} >/dev/null 2>&1
A=$(mktemp); B=$(mktemp)
nomad-pack render ${pack} --registry ${name} --ref ${from}${varFlag} > "$A" 2>/dev/null
nomad-pack render ${pack} --registry ${name} --ref ${to}${varFlag} > "$B" 2>/dev/null
diff -u "$A" "$B"
rm -f "$A" "$B" ${hasVars ? `"${vf}"` : ""}
`;
	return run(compose.serverId, cmd);
};
