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
