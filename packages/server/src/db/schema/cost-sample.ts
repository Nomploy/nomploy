import {
	doublePrecision,
	index,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

/**
 * A point-in-time snapshot of cost, written by the cost sampler (every few
 * minutes) from {@link computeCostReport}. Cost has no external TSDB, so we keep
 * our own rolling history here to power the Metrics dashboard charts and the cost
 * alert rules (both read the latest / windowed rows instead of recomputing live).
 *
 * Two row kinds per sample tick, distinguished by `projectId`:
 *  - cluster (`projectId` NULL): `total`/`allocated`/`platform`/`idle` set,
 *    `monthly` = total run-rate.
 *  - project (`projectId` set): `monthly` = that project's allocated cost;
 *    the total columns are null.
 */
export const costSample = pgTable(
	"cost_sample",
	{
		sampleId: text("sampleId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId").notNull(),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		// Null = the cluster-wide row; set = a per-project row.
		projectId: text("projectId"),
		projectName: text("projectName"),
		// €/month for this row (project cost, or the cluster run-rate on cluster rows).
		monthly: doublePrecision("monthly").notNull().default(0),
		// Cluster-row breakdown (null on project rows).
		total: doublePrecision("total"),
		allocated: doublePrecision("allocated"),
		platform: doublePrecision("platform"),
		idle: doublePrecision("idle"),
	},
	(t) => ({
		orgIdx: index("cost_sample_org_idx").on(
			t.organizationId,
			t.projectId,
			t.createdAt,
		),
	}),
);
