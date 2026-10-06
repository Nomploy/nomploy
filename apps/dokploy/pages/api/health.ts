import { db } from "@nomploy/server/db";
import { sql } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

// Readiness gate for the panel's Nomad health check. The panel job promotes its
// canary on this check (update { health_check = "checks" }). The old handler
// returned 200 immediately — the instant Next could answer an API route — so the
// canary promoted before the app could actually serve pages/tRPC (and even with
// Postgres unreachable). Traefik then cut traffic over to an alloc that 502'd on
// real requests: the panel-roll downtime.
//
// Now it reports ready only once Postgres answers, so the canary is only promoted
// into an alloc that can serve DB-backed requests (this also closes the known
// roll failure mode where a new alloc comes up before Postgres is accepting
// connections). The `ready` latch keeps it green after the first success, so a
// steady-state DB blip can't flap the already-serving panel out of Traefik — the
// gate applies to startup only, then behaves like the old always-200 liveness
// check. Safe because the panel job has no check_restart: a failing check only
// affects routing/promotion, it never kills the running alloc.
let ready = false;

const DB_TIMEOUT_MS = 2000; // under the Nomad check timeout (3s)

export default async function handler(
	_req: NextApiRequest,
	res: NextApiResponse,
) {
	if (ready) {
		return res.status(200).json({ ok: true });
	}
	try {
		await Promise.race([
			db.execute(sql`select 1`),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("db readiness timeout")),
					DB_TIMEOUT_MS,
				),
			),
		]);
		ready = true;
		return res.status(200).json({ ok: true, warmed: true });
	} catch {
		return res.status(503).json({ ok: false, warming: true });
	}
}
