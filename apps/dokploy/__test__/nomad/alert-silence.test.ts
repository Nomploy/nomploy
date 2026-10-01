import { isSilenced } from "@nomploy/server/services/alerts";
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
