import { dbUrl } from "@nomploy/server/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// On a cold boot (e.g. after a host reboot / hardware failure) the panel can
// start before Postgres is accepting connections. Retry the migration while the
// error looks like a connection problem, so the control plane comes back on its
// own instead of starting a broken panel or silently skipping migrations.
const MAX_ATTEMPTS = 30;
const DELAY_MS = 3000;

const isConnError = (e: unknown): boolean => {
	const err = e as { code?: string; message?: string; errno?: string };
	const code = err?.code ?? err?.errno ?? "";
	if (
		[
			"ECONNREFUSED",
			"ETIMEDOUT",
			"ENOTFOUND",
			"EHOSTUNREACH",
			"CONNECT_TIMEOUT",
			"CONNECTION_CLOSED",
			"CONNECTION_ENDED",
		].includes(code)
	) {
		return true;
	}
	const msg = (err?.message ?? "").toLowerCase();
	return (
		msg.includes("connect") ||
		msg.includes("timeout") ||
		msg.includes("terminating connection") ||
		msg.includes("the database system is starting up")
	);
};

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
	const sql = postgres(dbUrl, { max: 1 });
	try {
		await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
		console.log("Migration complete");
		await sql.end();
		break;
	} catch (error) {
		await sql.end().catch(() => {});
		if (isConnError(error)) {
			console.log(
				`Migration: database not ready (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${DELAY_MS / 1000}s`,
			);
			if (attempt === MAX_ATTEMPTS) {
				console.error(
					"Migration: database unreachable after retries — exiting so the orchestrator restarts us once it is ready.",
				);
				process.exit(1);
			}
			await new Promise((r) => setTimeout(r, DELAY_MS));
			continue;
		}
		// Non-connection (e.g. SQL) error: log and continue to start the server, as
		// before — don't turn a migration hiccup into a full control-plane outage.
		console.log("Migration failed", error);
		break;
	}
}
