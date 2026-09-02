import {
	getBuildNomadDatabaseCommand,
	type NomadDatabaseInput,
} from "../builders/nomad-database";
import { execAsync, execAsyncRemote } from "../process/execAsync";

type NomadAgentSelf = { member: { Name: string; Tags?: { region?: string } } };

// The Nomad client node name (what ${node.unique.name} matches) is the agent's
// member name without the ".<region>" suffix agent/self reports (e.g.
// "nomploy.global" → "nomploy").
const nodeNameFromSelf = (self: NomadAgentSelf): string => {
	const { Name, Tags } = self.member;
	const region = Tags?.region;
	return region && Name.endsWith(`.${region}`)
		? Name.slice(0, -(region.length + 1))
		: Name;
};

// Resolve the Nomad client node a database must be pinned to (its data lives in a
// node-local volume). Control-plane databases pin to the hub's node; a
// server-scoped database pins to that server's node.
export const resolveNomadNodeName = async (
	serverId?: string | null,
): Promise<string> => {
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			"curl -s http://127.0.0.1:4646/v1/agent/self",
		);
		return nodeNameFromSelf(JSON.parse(stdout));
	}
	const addr = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
	const res = await fetch(`${addr}/v1/agent/self`);
	return nodeNameFromSelf((await res.json()) as NomadAgentSelf);
};

/**
 * Deploy a stateful database to Nomad: pin it to its node, write the HCL job and
 * submit it. Shared by every database engine — the caller supplies the
 * engine-specific bits (port, data dir, env). Replaces the Docker Swarm service.
 */
export const deployDatabaseToNomad = async (
	input: Omit<NomadDatabaseInput, "targetNodeName">,
	serverId: string | null | undefined,
	onData?: (data: unknown) => void,
): Promise<void> => {
	const targetNodeName = await resolveNomadNodeName(serverId);
	const command = getBuildNomadDatabaseCommand({ ...input, targetNodeName });
	if (serverId) {
		await execAsyncRemote(serverId, command, onData);
	} else {
		const { stdout } = await execAsync(command);
		onData?.(stdout);
	}
};
