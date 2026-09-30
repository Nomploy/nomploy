// Pure series math for the autoscaling instances-over-time charts. Kept free of
// React/recharts imports so it's unit-testable in the node test env.

export interface Ev {
	type: string;
	createdAt: string;
	groupId?: string | null;
}

export type SeriesPoint = { t: number; count: number };

/**
 * Reconstruct a group's running-node count over time from the autoscaler event
 * log. recordEvent is the single chokepoint for every scale action, so walking
 * the scale_up/scale_down events backward from the current count yields an
 * accurate step timeline — no separate time-series store needed. (Manual/
 * provider-side changes outside the autoscaler aren't captured; a sampled series
 * is the more robust follow-up.)
 */
export const buildSeries = (
	currentCount: number,
	events: Ev[], // newest-first, already filtered to this group
): SeriesPoint[] => {
	const scale = events.filter(
		(e) => e.type === "scale_up" || e.type === "scale_down",
	);
	let count = currentCount;
	const pts: SeriesPoint[] = [{ t: Date.now(), count }];
	for (const e of scale) {
		const t = new Date(e.createdAt).getTime();
		pts.push({ t, count: Math.max(0, count) });
		// Value before this event (older interval).
		count = e.type === "scale_up" ? count - 1 : count + 1;
	}
	if (scale.length > 0) {
		const oldest = new Date(scale[scale.length - 1]!.createdAt).getTime();
		pts.push({ t: oldest - 1000, count: Math.max(0, count) });
	}
	return pts.sort((a, b) => a.t - b.t);
};

/**
 * Clip an ascending series to [from, now], carrying the count active at `from`
 * forward to a synthetic leading point so the step line spans the whole window
 * even when the last scale event predates it. `from === null` → no clipping.
 */
export const clipSeries = (
	series: SeriesPoint[],
	from: number | null,
	now: number,
): SeriesPoint[] => {
	if (from === null) return series;
	const within = series.filter((p) => p.t >= from && p.t <= now);
	// The count in effect at `from` = the newest point at or before it.
	const active = [...series].reverse().find((p) => p.t <= from);
	const head: SeriesPoint = {
		t: from,
		count: active?.count ?? within[0]?.count ?? 0,
	};
	const tail: SeriesPoint[] =
		within.length === 0 || within[within.length - 1]!.t < now
			? [{ t: now, count: series[series.length - 1]?.count ?? head.count }]
			: [];
	return [head, ...within, ...tail];
};
