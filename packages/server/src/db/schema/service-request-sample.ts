import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

/**
 * A point-in-time snapshot of one service's CUMULATIVE Traefik request counter
 * (`traefik_service_requests_total`, summed across the LB nodes and across the
 * service's routers), taken by the load-balancer metrics sampler. Nomad/Traefik
 * keep no local TSDB, so we keep a short rolling history here to answer "how many
 * requests in the last N minutes" and "how long has this service been idle" —
 * which powers the scale-to-zero idle display (and, later, auto-sleep). Keyed by
 * `appName` (the Nomad job id). Rows past the retention window are pruned.
 */
export const serviceRequestSample = pgTable(
	"service_request_sample",
	{
		sampleId: text("sampleId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		// The Nomad job id (== the service's appName).
		appName: text("appName").notNull(),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		// Cumulative Traefik request count for this service at sample time.
		requests: integer("requests").notNull().default(0),
	},
	(t) => ({
		appNameIdx: index("service_request_sample_appName_idx").on(
			t.appName,
			t.createdAt,
		),
	}),
);
