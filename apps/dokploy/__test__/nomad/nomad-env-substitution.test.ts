import { parseComposeToNomadServices } from "@nomploy/server/utils/builders/nomad-parser";
import { describe, expect, it } from "vitest";

// Compose interpolation happens on the raw YAML before parsing; assert through the
// parsed service env so we test what actually reaches the Nomad job.
const envOf = (value: string, vars: Record<string, string>) => {
	const compose = `services:\n  web:\n    image: nginx\n    environment:\n      V: "${value}"\n`;
	return parseComposeToNomadServices(compose, vars)[0]?.env.V;
};

describe("nomad parser — compose variable interpolation", () => {
	it("keeps the existing ${VAR}, $VAR and default forms", () => {
		expect(envOf("${A}", { A: "x" })).toBe("x");
		expect(envOf("$A-suffix", { A: "x" })).toBe("x-suffix");
		expect(envOf("${A}", {})).toBe("");
		expect(envOf("${A:-d}", { A: "" })).toBe("d");
		expect(envOf("${A-d}", { A: "" })).toBe("");
		expect(envOf("${A-d}", {})).toBe("d");
		expect(envOf("${A:-d}", { A: "x" })).toBe("x");
	});

	it("resolves nested defaults inner-first", () => {
		expect(envOf("${A:-${B}}", { B: "b" })).toBe("b");
		expect(envOf("${A:-${B:-c}}", {})).toBe("c");
		expect(envOf("${A:-${B:-c}}", { A: "a", B: "b" })).toBe("a");
		expect(envOf("${A:-pre-${B}-post}", { B: "b" })).toBe("pre-b-post");
	});

	it("${VAR:?msg} fails when unset or empty", () => {
		expect(() => envOf("${A:?A is required}", {})).toThrow(
			"Required variable A is missing a value: A is required",
		);
		expect(() => envOf("${A:?A is required}", { A: "" })).toThrow(
			"A is required",
		);
		expect(envOf("${A:?A is required}", { A: "x" })).toBe("x");
	});

	it("${VAR?msg} fails only when unset", () => {
		expect(() => envOf("${A?need A}", {})).toThrow("need A");
		expect(envOf("${A?need A}", { A: "" })).toBe("");
		expect(envOf("${A?}", { A: "x" })).toBe("x");
		expect(() => envOf("${A?}", {})).toThrow(
			"Required variable A is missing a value",
		);
	});

	it("leaves non-variable ${…} text alone", () => {
		expect(envOf("${}", {})).toBe("${}");
	});
});
