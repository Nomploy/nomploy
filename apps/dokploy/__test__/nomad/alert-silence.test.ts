import { isSilenceActive, isSilenced } from "@nomploy/server/services/alerts";
import { describe, expect, it } from "vitest";

type S = {
	alertRuleId: string | null;
	target: string | null;
	severity: string | null;
};
const silence = (p: Partial<S>): S => ({
	alertRuleId: null,
	target: null,
	severity: null,
	...p,
});

describe("isSilenced — silence matcher", () => {
	const ctx = { alertRuleId: "rule-1", target: "myapp", severity: "warning" };

	it("empty-matcher silence (maintenance window) matches everything", () => {
		expect(isSilenced([silence({})], ctx)).toBe(true);
		expect(
			isSilenced([silence({})], {
				alertRuleId: "other",
				target: null,
				severity: "critical",
			}),
		).toBe(true);
	});

	it("rule-scoped silence matches only that rule", () => {
		expect(isSilenced([silence({ alertRuleId: "rule-1" })], ctx)).toBe(true);
		expect(isSilenced([silence({ alertRuleId: "rule-2" })], ctx)).toBe(false);
	});

	it("service-scoped silence matches only that target", () => {
		expect(isSilenced([silence({ target: "myapp" })], ctx)).toBe(true);
		expect(isSilenced([silence({ target: "other" })], ctx)).toBe(false);
		// a service silence never matches a pool (null-target) alert
		expect(
			isSilenced([silence({ target: "myapp" })], {
				alertRuleId: "r",
				target: null,
				severity: "warning",
			}),
		).toBe(false);
	});

	it("severity-scoped silence matches only that severity", () => {
		expect(isSilenced([silence({ severity: "warning" })], ctx)).toBe(true);
		expect(isSilenced([silence({ severity: "critical" })], ctx)).toBe(false);
	});

	it("all non-null matchers must match (AND)", () => {
		expect(
			isSilenced([silence({ alertRuleId: "rule-1", target: "myapp" })], ctx),
		).toBe(true);
		expect(
			isSilenced([silence({ alertRuleId: "rule-1", target: "other" })], ctx),
		).toBe(false);
	});

	it("any one active silence matching is enough", () => {
		const silences = [
			silence({ target: "other" }),
			silence({ severity: "warning" }),
		];
		expect(isSilenced(silences, ctx)).toBe(true);
	});

	it("no silences → not silenced", () => {
		expect(isSilenced([], ctx)).toBe(false);
	});
});

describe("isSilenceActive — one-shot + recurring windows", () => {
	const bounds = {
		startsAt: new Date("2026-01-01T00:00:00Z"),
		endsAt: new Date("2027-01-01T00:00:00Z"),
	};
	const win = (p: Record<string, unknown>) => ({
		...bounds,
		recurring: false,
		recurStartMinute: null,
		recurEndMinute: null,
		recurDays: null,
		...p,
	});
	// Monday 2026-10-05 03:00 UTC.
	const now = new Date("2026-10-05T03:00:00Z");
	const wd = now.getUTCDay();

	it("one-shot: active within bounds, inactive outside", () => {
		expect(isSilenceActive(win({}), now)).toBe(true);
		expect(
			isSilenceActive(
				win({ endsAt: new Date("2026-02-01T00:00:00Z") }),
				now,
			),
		).toBe(false);
	});

	it("recurring: active inside the daily window (every day)", () => {
		const s = win({
			recurring: true,
			recurStartMinute: 120, // 02:00
			recurEndMinute: 240, // 04:00
			recurDays: [],
		});
		expect(isSilenceActive(s, now)).toBe(true); // 03:00 in [02:00,04:00)
		expect(
			isSilenceActive(s, new Date("2026-10-05T05:00:00Z")),
		).toBe(false); // 05:00 outside
		expect(
			isSilenceActive(s, new Date("2026-10-05T04:00:00Z")),
		).toBe(false); // end is exclusive
	});

	it("recurring: weekday gating", () => {
		const base = {
			recurring: true,
			recurStartMinute: 120,
			recurEndMinute: 240,
		};
		expect(isSilenceActive(win({ ...base, recurDays: [wd] }), now)).toBe(true);
		expect(
			isSilenceActive(win({ ...base, recurDays: [(wd + 1) % 7] }), now),
		).toBe(false);
	});

	it("recurring: inactive outside overall bounds even in-window", () => {
		const s = win({
			startsAt: new Date("2026-10-06T00:00:00Z"), // starts tomorrow
			recurring: true,
			recurStartMinute: 120,
			recurEndMinute: 240,
			recurDays: [],
		});
		expect(isSilenceActive(s, now)).toBe(false);
	});
});
