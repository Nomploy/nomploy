import { describe, expect, it } from "vitest";
import {
	buildSeries,
	clipSeries,
} from "@/components/dashboard/nomad/autoscale/autoscaling-series";

const HOUR = 3_600_000;

describe("buildSeries — reconstruct node count from scale events", () => {
	it("walks scale_up/scale_down backward from the current count", () => {
		const now = Date.now();
		// newest-first: two up events → count went 0→1→2, currently 2.
		const series = buildSeries(2, [
			{ type: "scale_up", createdAt: new Date(now - HOUR).toISOString() },
			{ type: "scale_up", createdAt: new Date(now - 2 * HOUR).toISOString() },
		]);
		// ascending by t, ending at the current count
		expect(series[series.length - 1]?.count).toBe(2);
		// before the first (oldest) up event the count was 0
		expect(series[0]?.count).toBe(0);
		expect(series.every((p, i) => i === 0 || p.t >= series[i - 1]!.t)).toBe(
			true,
		);
	});
});

describe("clipSeries — window to [from, now]", () => {
	const now = 10 * HOUR;
	// count 0 until 3h, then 2 from 3h onward (stepAfter semantics).
	const series = [
		{ t: 1 * HOUR, count: 0 },
		{ t: 3 * HOUR, count: 2 },
		{ t: now, count: 2 },
	];

	it("returns the series unchanged when from is null (All)", () => {
		expect(clipSeries(series, null, now)).toBe(series);
	});

	it("carries the active count forward to a synthetic leading point at `from`", () => {
		// window starts at 5h — after the last event (3h). Head must carry count=2.
		const out = clipSeries(series, 5 * HOUR, now);
		expect(out[0]).toEqual({ t: 5 * HOUR, count: 2 });
		expect(out[0]!.t).toBe(5 * HOUR);
		// spans to now
		expect(out[out.length - 1]!.t).toBe(now);
	});

	it("keeps in-window points and drops earlier ones", () => {
		const out = clipSeries(series, 2 * HOUR, now);
		// head at 2h (carried 0), then the 3h and now points survive
		expect(out.map((p) => p.t)).toEqual([2 * HOUR, 3 * HOUR, now]);
		expect(out[0]!.count).toBe(0);
	});

	it("synthesizes a trailing point at now when the last event predates the window end", () => {
		const flat = [
			{ t: 1 * HOUR, count: 1 },
			{ t: 2 * HOUR, count: 1 },
		];
		const out = clipSeries(flat, 90 * 60_000, 8 * HOUR);
		expect(out[out.length - 1]).toEqual({ t: 8 * HOUR, count: 1 });
	});
});
