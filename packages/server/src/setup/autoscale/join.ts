import { findServerById, updateServerById } from "../../services/server";
import { execAsync, execAsyncRemote } from "../../utils/process/execAsync";
import {
	getClusterServerJoinCommand,
	getClusterWorkerJoinCommand,
} from "../nomad-cluster";
import {
	addPeerEverywhere,
	allMeshMembers,
	allocateWgIp,
	allServers,
	readCluster,
	readClusterAclTokens,
	removePeerEverywhere,
	serverMeshMembers,
	writeCluster,
} from "../nomad-mesh";

type Log = (s: string) => void;

/**
 * Join a server (by id) to the cluster as a Nomad/Consul worker over the
 * WireGuard mesh. Single source of truth reused by the UI (nomad.joinCluster)
 * and the cluster autoscaler. Installs + configures the node, registers its
 * WireGuard peer on every server, and records membership in cluster.json + DB.
 * Returns the assigned overlay IP.
 */
export const joinWorkerNode = async (
	serverId: string,
	onLog: Log = () => {},
	nodePool?: string,
): Promise<{ wgIp: string; publicKey: string }> => {
	const server = await findServerById(serverId);
	const cluster = readCluster();
	if (!cluster) throw new Error("Cluster not initialized on the control plane");
	const overlayCidr = cluster.overlayCidr || "10.10.0.0/24";

	const wgIp = allocateWgIp(cluster, "worker");
	onLog(`Assigning worker overlay IP ${wgIp} to "${server.name}"\n`);

	const script = getClusterWorkerJoinCommand({
		hubPublicKey: cluster.hubPublicKey,
		hubEndpoint: cluster.hubEndpoint,
		gossipKey: cluster.gossipKey,
		workerWgIp: wgIp,
		hubWgIp: cluster.hubWgIp,
		overlayCidr,
		servers: (cluster.servers || []).map((s) => ({
			wgIp: s.wgIp,
			publicKey: s.publicKey,
			endpoint: s.endpoint,
		})),
		aclTokens: readClusterAclTokens(),
		nodePool,
	});

	let pubkey = "";
	await execAsyncRemote(serverId, script, (log) => {
		onLog(log);
		const cap = log.match(/WORKER_WG_PUBKEY=(\S+)/)?.[1];
		if (cap) pubkey = cap.trim();
	});
	if (!pubkey) throw new Error("Did not receive the worker's WireGuard key");

	onLog(`\nRegistering WireGuard peer on all servers (${wgIp})\n`);
	await addPeerEverywhere(
		{ wgIp, publicKey: pubkey },
		serverMeshMembers(cluster),
		onLog,
	);

	cluster.peers.push({ wgIp, publicKey: pubkey, serverId, name: server.name });
	writeCluster(cluster);
	await updateServerById(serverId, {
		nomadAddress: `http://${wgIp}:4646`,
		clusterRole: "worker",
		wgIp,
		wgPublicKey: pubkey,
		nodePool: nodePool || "default",
	});
	return { wgIp, publicKey: pubkey };
};

/**
 * Join a server (by id) to the cluster as a Nomad/Consul SERVER (raft member)
 * over the WireGuard mesh — the HA path. Full-mesh with the other servers, adds
 * its WireGuard peer to every member, and records membership. Returns the
 * assigned overlay IP + public key.
 */
export const joinServerNode = async (
	serverId: string,
	onLog: Log = () => {},
): Promise<{ wgIp: string; publicKey: string }> => {
	const server = await findServerById(serverId);
	const cluster = readCluster();
	if (!cluster) throw new Error("Cluster not initialized on the control plane");
	const overlayCidr = cluster.overlayCidr || "10.10.0.0/24";

	const wgIp = allocateWgIp(cluster, "server");
	onLog(`Assigning server overlay IP ${wgIp} to "${server.name}"\n`);
	const servers = allServers(cluster);

	const script = getClusterServerJoinCommand({
		ownWgIp: wgIp,
		gossipKey: cluster.gossipKey,
		bootstrapExpect: Math.min(servers.length + 1, 3),
		serverWgIps: [...servers.map((s) => s.wgIp), wgIp],
		otherServers: servers.map((s) => ({
			wgIp: s.wgIp,
			publicKey: s.publicKey,
			endpoint: s.endpoint,
		})),
		existingWorkers: cluster.peers.map((p) => ({
			wgIp: p.wgIp,
			publicKey: p.publicKey,
		})),
		overlayCidr,
		aclTokens: readClusterAclTokens(),
	});

	let pubkey = "";
	await execAsyncRemote(serverId, script, (log) => {
		onLog(log);
		const cap = log.match(/SERVER_WG_PUBKEY=(\S+)/)?.[1];
		if (cap) pubkey = cap.trim();
	});
	if (!pubkey) throw new Error("Did not receive the server's WireGuard key");

	const endpoint = `${server.ipAddress}:51820`;
	onLog(`\nRegistering WireGuard peer on all members (${wgIp})\n`);
	await addPeerEverywhere(
		{ wgIp, publicKey: pubkey, endpoint },
		allMeshMembers(cluster).filter((m) => m.serverId !== serverId),
		onLog,
	);

	cluster.servers = cluster.servers || [];
	cluster.servers.push({
		wgIp,
		publicKey: pubkey,
		serverId,
		name: server.name,
		endpoint,
	});
	writeCluster(cluster);
	await updateServerById(serverId, {
		nomadAddress: `http://${wgIp}:4646`,
		clusterRole: "server",
		wgIp,
		wgPublicKey: pubkey,
	});
	return { wgIp, publicKey: pubkey };
};

/**
 * Remove a worker node from the cluster: drain it, stop its services + wipe its
 * Nomad/Consul data dirs (so a rejoin is clean), remove its WireGuard peer from
 * every server, and clear its membership. Worker-only — server removal (raft) is
 * handled by the quorum-safe path in the nomad router.
 */
export const removeWorkerNode = async (
	serverId: string,
	onLog: Log = () => {},
): Promise<void> => {
	const cluster = readCluster();
	if (!cluster) throw new Error("Cluster not initialized");
	const worker = cluster.peers.find((p) => p.serverId === serverId);
	if (!worker) throw new Error("This server is not a worker cluster member");

	// Drain the Nomad node (match by its overlay IP) if we can find it.
	try {
		const res = await execAsync("nomad node status -json 2>/dev/null || true");
		const list = JSON.parse(res.stdout || "[]") as {
			ID: string;
			Address: string;
		}[];
		const node = list.find((n) => n.Address === worker.wgIp);
		if (node) {
			onLog(`Draining node ${node.ID} …\n`);
			await execAsync(
				`nomad node drain -enable -yes -deadline 3m ${node.ID}`,
			).catch(() => {});
		}
	} catch {}

	onLog("Stopping services + WireGuard + wiping data dirs on the node …\n");
	await execAsyncRemote(
		serverId,
		'SUDO=""; [ "$EUID" -ne 0 ] && SUDO=sudo; $SUDO systemctl stop nomad consul 2>/dev/null || true; $SUDO wg-quick down wg0 2>/dev/null || true; $SUDO systemctl disable wg-quick@wg0 2>/dev/null || true; $SUDO rm -rf /opt/nomad/client /opt/nomad/server /opt/nomad/data /opt/consul/* 2>/dev/null || true',
	).catch((e) =>
		onLog(`⚠ node cleanup: ${e instanceof Error ? e.message : String(e)}\n`),
	);
	await execAsync("nomad system gc").catch(() => {});
	await execAsync(`consul force-leave ${worker.name}`).catch(() => {});

	onLog("Removing WireGuard peer from all servers …\n");
	await removePeerEverywhere(
		worker.publicKey,
		serverMeshMembers(cluster).filter((m) => m.serverId !== serverId),
		onLog,
	);

	cluster.peers = cluster.peers.filter((p) => p.serverId !== serverId);
	writeCluster(cluster);
	await updateServerById(serverId, {
		nomadAddress: null,
		clusterRole: null,
		wgIp: null,
		wgPublicKey: null,
	});
};
