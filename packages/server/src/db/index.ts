import { and, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { dbUrl } from "./constants";
import * as schema from "./schema";

export { and, eq };
export * from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

/**
 * Evita problemas de redeclaración global en monorepos.
 * No usamos `declare global`.
 */
const globalForDb = globalThis as unknown as {
	db?: Database;
};

let dbConnection: Database;

if (process.env.NODE_ENV === "production") {
	// En producción no usamos global cache
	dbConnection = drizzle(postgres(dbUrl), {
		schema,
	});
} else {
	// En desarrollo reutilizamos conexión para evitar múltiples conexiones
	if (!globalForDb.db) {
		globalForDb.db = drizzle(postgres(dbUrl), {
			schema,
		});
	}

	dbConnection = globalForDb.db;
}

export const db: Database = dbConnection;

/**
 * Block until Postgres answers a trivial `SELECT 1`, retrying with a fixed delay.
 *
 * The panel runs as a Nomad job on the same host as its Postgres, and a rolling
 * panel deploy (or a Consul/raft blip) can briefly make 127.0.0.1:5432
 * unreachable for a few seconds. Without this, better-auth's DB calls during
 * `app.prepare()` reject with `CONNECT_TIMEOUT`, the boot promise goes unhandled,
 * and Node exits 1 — turning a 2-second blip into a failed alloc. Waiting here
 * absorbs the blip; the default budget (~90s) stays well under the job's 5m
 * healthy_deadline, so a genuinely-down DB still fails fast enough for
 * auto_revert to keep the old alloc.
 */
export async function waitForDatabase({
	retries = 30,
	delayMs = 3000,
}: {
	retries?: number;
	delayMs?: number;
} = {}): Promise<void> {
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			await db.execute(sql`select 1`);
			if (attempt > 1) {
				console.log(`✅ Database reachable after ${attempt} attempts`);
			}
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`⏳ Database not ready (attempt ${attempt}/${retries}): ${message}`,
			);
			if (attempt === retries) {
				// Budget exhausted: continue boot anyway rather than hard-exiting, and
				// let the job's health check + auto_revert handle a truly-down DB.
				console.error(
					"❌ Database still unreachable after retries; continuing boot",
				);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

export { dbUrl };
