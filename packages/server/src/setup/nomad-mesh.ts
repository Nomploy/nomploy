import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";

/**
 * Cluster membership + WireGuard mesh orchestration for the multi-node,
 * HA-capable Nomad cluster.
 *
 * `/etc/nomploy/cluster.json` (written by install.sh, bind-mounted into the panel
 * container) is the source of truth for the WireGuard overlay: the hub's keys and
 * gossip key, the overlay CIDR, the extra Nomad/Consul **servers** and the
 * **workers**. The original control-plane hub stays implicit in the top-level
 * `hub*` fields (so a live pre-HA file keeps working) and is treated as server #1.
 *
 * IP ranges on the overlay: servers use `.1`–`.10` (hub is `.1`), workers `.11`+.
 * The hub + every server forward the overlay and full-mesh with each other; a
 * worker peers all servers (hub as the `/24` gateway, others `/32`) so it fails
 * over to a surviving server if the hub dies.
 */

export const CLUSTER_FILE = "/etc/nomploy/cluster.json";

export interface ClusterServerEntry {
	wgIp: string;
	publicKey: string;
	serverId: string;
	name: string;
	/** host:51820 the other members dial to reach this server. */
	endpoint: string;
}

export interface ClusterPeerEntry {
	wgIp: string;
	publicKey: string;
	serverId: string;
	name: string;
}

export interface ClusterState {
	hubPublicKey: string;
	gossipKey: string;
	hubWgIp: string;
	hubEndpoint: string;
	overlayCidr?: string;
	/** Extra Nomad/Consul servers (HA), excluding the implicit hub. */
	servers?: ClusterServerEntry[];
	/** Worker (client) nodes. */
	peers: ClusterPeerEntry[];
}

/** A member we can run `wg` on: the hub is local (no serverId), others via SSH. */
export interface MeshMember {
	wgIp: string;
	name: string;
	serverId?: string;
}

export const readCluster = (): ClusterState | null => {
	if (!existsSync(CLUSTER_FILE)) return null;
	const c = JSON.parse(readFileSync(CLUSTER_FILE, "utf8")) as ClusterState;
	c.peers = c.peers || [];
	c.servers = c.servers || [];
	return c;
};

export const writeCluster = (c: ClusterState): void => {
	writeFileSync(CLUSTER_FILE, JSON.stringify(c, null, 2));
};

/** All Nomad/Consul servers including the implicit hub (hub first). */
export const allServers = (c: ClusterState): ClusterServerEntry[] => [
	{
		wgIp: c.hubWgIp,
		publicKey: c.hubPublicKey,
		serverId: "",
		name: "control-plane",
		endpoint: c.hubEndpoint,
	},
	...(c.servers ?? []),
];

/** Members that run a server (hub + servers) — targets for worker peer fan-out. */
export const serverMeshMembers = (c: ClusterState): MeshMember[] => [
	{ wgIp: c.hubWgIp, name: "control-plane" },
	...(c.servers ?? []).map((s) => ({
		wgIp: s.wgIp,
		name: s.name,
		serverId: s.serverId,
	})),
];

/** Every member (hub + servers + workers) — targets for server peer fan-out. */
export const allMeshMembers = (c: ClusterState): MeshMember[] => [
	...serverMeshMembers(c),
	...c.peers.map((p) => ({ wgIp: p.wgIp, name: p.name, serverId: p.serverId })),
];

/** Next free overlay IP: servers `.2`–`.10`, workers `.11`–`.254`. */
export const allocateWgIp = (
	c: ClusterState,
	kind: "server" | "worker",
): string => {
	const prefix = c.hubWgIp.replace(/\.\d+$/, "");
	const used = new Set<string>([
		c.hubWgIp,
		...(c.servers ?? []).map((s) => s.wgIp),
		...c.peers.map((p) => p.wgIp),
	]);
	const [start, end] = kind === "server" ? [2, 10] : [11, 254];
	for (let n = start; n <= end; n++) {
		const ip = `${prefix}.${n}`;
		if (!used.has(ip)) return ip;
	}
	throw new Error(
		`No free ${kind} overlay IP available in .${start}-.${end} range`,
	);
};

const runOnMember = (m: MeshMember, cmd: string) =>
	m.serverId ? execAsyncRemote(m.serverId, cmd) : execAsync(cmd);

/**
 * Register `peer` on every `member`'s wg0 (idempotent — `wg set peer` upserts).
 * `endpoint` is set for server peers (so members can dial them); worker peers are
 * learned passively (no endpoint). Failures are logged, not thrown, so a partial
 * mesh can be re-run.
 */
export const addPeerEverywhere = async (
	peer: { wgIp: string; publicKey: string; endpoint?: string },
	members: MeshMember[],
	onLog?: (s: string) => void,
): Promise<void> => {
	const endpointArg = peer.endpoint ? ` endpoint ${peer.endpoint}` : "";
	const cmd = `wg set wg0 peer ${peer.publicKey} allowed-ips ${peer.wgIp}/32${endpointArg} && wg-quick save wg0`;
	for (const m of members) {
		onLog?.(`  + wg peer ${peer.wgIp} on ${m.name}\n`);
		try {
			await runOnMember(m, cmd);
		} catch (e) {
			onLog?.(
				`  ⚠ could not add peer on ${m.name}: ${e instanceof Error ? e.message : String(e)}\n`,
			);
		}
	}
};

/** Remove a peer (by public key) from every `member`'s wg0. */
export const removePeerEverywhere = async (
	publicKey: string,
	members: MeshMember[],
	onLog?: (s: string) => void,
): Promise<void> => {
	const cmd = `wg set wg0 peer ${publicKey} remove && wg-quick save wg0`;
	for (const m of members) {
		onLog?.(`  - wg peer on ${m.name}\n`);
		try {
			await runOnMember(m, cmd);
		} catch (e) {
			onLog?.(
				`  ⚠ could not remove peer on ${m.name}: ${e instanceof Error ? e.message : String(e)}\n`,
			);
		}
	}
};
