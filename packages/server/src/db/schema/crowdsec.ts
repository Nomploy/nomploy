import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

/**
 * A rolling sample of the CrowdSec active-ban count. CrowdSec is cluster-wide
 * (one detector on the hub), so this series is global — not scoped to an org.
 * Written once a minute by the sampler when CrowdSec is enabled, and read by the
 * Security page's bans-over-time chart and the `crowdsec_active_bans` alert.
 */
export const crowdsecBanSample = pgTable(
	"crowdsec_ban_sample",
	{
		crowdsecBanSampleId: text("crowdsecBanSampleId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		ts: timestamp("ts").notNull().defaultNow(),
		activeBans: integer("activeBans").notNull().default(0),
	},
	(t) => ({
		tsIdx: index("crowdsec_ban_sample_ts_idx").on(t.ts),
	}),
);
