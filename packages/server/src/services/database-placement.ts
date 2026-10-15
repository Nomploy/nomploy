import { db } from "../db";
import {
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
	server,
} from "../db/schema";
import { resolveNomadNodeName } from "../utils/databases/nomad-deploy";

const NOMAD_ADDR = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const nomadHeaders = (): Record<string, string> =>
	process.env.NOMAD_TOKEN ? { "X-Nomad-Token": process.env.NOMAD_TOKEN } : {};

/**
 * Host ports actually reserved by running allocations on the node a database would
 * pin to — the authoritative source (catches orphaned jobs, non-database services,
 * or any DB-record/Nomad drift that counting our own rows would miss). Best-effort:
 * returns an empty set when Nomad is unreachable, so placement still proceeds.
 */
const nomadReservedPortsOnNode = async (
	serverId: string | null | undefined,
): Promise<Set<number>> => {
	const used = new Set<number>();
	try {
		const nodeName = await resolveNomadNodeName(serverId);
		const nodesRes = await fetch(`${NOMAD_ADDR}/v1/nodes`, {
			headers: nomadHeaders(),
		});
		if (!nodesRes.ok) return used;
		const nodes = (await nodesRes.json()) as { ID?: string; Name?: string }[];
		const node = nodes.find((n) => n.Name === nodeName);
		if (!node?.ID) return used;
		const allocRes = await fetch(
			`${NOMAD_ADDR}/v1/node/${node.ID}/allocations`,
			{ headers: nomadHeaders() },
		);
		if (!allocRes.ok) return used;
		const allocs = (await allocRes.json()) as {
			DesiredStatus?: string;
			AllocatedResources?: { Shared?: { Ports?: { Value?: number }[] } };
		}[];
		for (const a of allocs) {
			if (a.DesiredStatus !== "run") continue; // only allocs holding ports now
			for (const p of a.AllocatedResources?.Shared?.Ports ?? []) {
				if (p.Value) used.add(p.Value);
			}
		}
	} catch {
		// Nomad unreachable — fall back to DB-record counting only.
	}
	return used;
};

export type DatabaseEngine =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

const ENGINE_TABLE = {
	postgres,
	mysql,
	mariadb,
	mongo,
	redis,
	libsql,
} as const;

/** The standard host port each engine listens on (the default when a database
 * has no explicitly assigned internalPort). */
export const ENGINE_DEFAULT_PORT: Record<DatabaseEngine, number> = {
	postgres: 5432,
	mysql: 3306,
	mariadb: 3306,
	mongo: 27017,
	redis: 6379,
	libsql: 8080,
};

/**
 * Pick the registered server a NEW database of `engine` should pin to, so
 * databases **spread across worker nodes** instead of all piling onto the control
 * plane (the historical default, which also meant a port clash once the hub
 * already ran that engine). Returns the registered server with the fewest
 * databases of this engine — its static engine port is the most likely to be free
 * — or `null` when no server is registered (single-node cluster → control plane,
 * unchanged).
 *
 * Only used when the caller did NOT pass a `serverId`; existing databases keep
 * their `serverId` (their data lives in a node-local volume) and never move.
 */
export const pickServerForNewDatabase = async (
	engine: DatabaseEngine,
): Promise<string | null> => {
	const servers = await db.select({ serverId: server.serverId }).from(server);
	if (servers.length === 0) return null; // single-node → control plane

	const rows = await db
		.select({ serverId: ENGINE_TABLE[engine].serverId })
		.from(ENGINE_TABLE[engine]);
	const countByServer = new Map<string, number>();
	for (const r of rows) {
		if (r.serverId)
			countByServer.set(r.serverId, (countByServer.get(r.serverId) ?? 0) + 1);
	}

	let best: string | null = null;
	let bestCount = Number.POSITIVE_INFINITY;
	for (const s of servers) {
		const n = countByServer.get(s.serverId) ?? 0;
		if (n < bestCount) {
			bestCount = n;
			best = s.serverId;
		}
	}
	return best;
};

/**
 * Pick a free host port for a NEW database of `engine` on the node it's pinned to
 * (`serverId`, null = control plane). Each database binds its own static host
 * port so several of the same engine can share a node; the connection endpoint
 * stays stable (the port is persisted). Starts at the engine's standard port and
 * climbs past any port already used by another database on that same node
 * (counting each one's `internalPort ?? engine default`, and its `externalPort`).
 */
export const pickInternalPort = async (
	serverId: string | null | undefined,
	engine: DatabaseEngine,
): Promise<number> => {
	const target = serverId ?? null;
	// Start from the host ports actually reserved on the node (authoritative —
	// catches orphans / non-DB services), then add our own records (covers
	// databases created but not yet placed, so they aren't absent from Nomad yet).
	const used = await nomadReservedPortsOnNode(target);
	for (const [eng, table] of Object.entries(ENGINE_TABLE)) {
		const rows = await db
			.select({
				serverId: table.serverId,
				internalPort: table.internalPort,
				externalPort: table.externalPort,
			})
			.from(table);
		for (const r of rows) {
			if ((r.serverId ?? null) !== target) continue; // only ports on this node
			used.add(r.internalPort ?? ENGINE_DEFAULT_PORT[eng as DatabaseEngine]);
			if (r.externalPort) used.add(r.externalPort);
		}
	}
	let port = ENGINE_DEFAULT_PORT[engine];
	while (used.has(port)) port++;
	return port;
};
