import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

/**
 * A point-in-time snapshot of one service's live resource usage vs its
 * reservation, taken by the metrics sampler (every few minutes) from Nomad
 * telemetry (publish_allocation_metrics). Nomad has no metrics TSDB, so we keep
 * our own short rolling history here to power the utilization/scaling
 * suggestions (over/under-provisioned, idle) and their daily digest. Keyed by
 * `appName` (the Nomad job id, unique per install) — the org/service it belongs
 * to is resolved when reading. Rows older than the retention window are pruned by
 * the sampler.
 */
export const serviceMetricSample = pgTable(
	"service_metric_sample",
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
		// Used vs reserved, in the units the UI shows.
		cpuUsedMhz: integer("cpuUsedMhz").notNull().default(0),
		cpuAllocMhz: integer("cpuAllocMhz").notNull().default(0),
		memUsedMb: integer("memUsedMb").notNull().default(0),
		memAllocMb: integer("memAllocMb").notNull().default(0),
	},
	(t) => ({
		appNameIdx: index("service_metric_sample_appName_idx").on(
			t.appName,
			t.createdAt,
		),
	}),
);
