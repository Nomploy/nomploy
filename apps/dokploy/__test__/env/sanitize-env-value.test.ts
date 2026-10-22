import {
	getEnvironmentVariablesObject,
	sanitizeEnvValue,
} from "@nomploy/server/index";
import { describe, expect, it } from "vitest";

describe("sanitizeEnvValue", () => {
	it("strips a pasted TAB (0x09) — the char Nomad rejects in an env value", () => {
		expect(sanitizeEnvValue("tru\te")).toBe("true");
	});

	it("strips carriage returns and other control chars, keeps newline", () => {
		expect(sanitizeEnvValue("a\rb\x00c\x1fd")).toBe("abcd");
		expect(sanitizeEnvValue("line1\nline2")).toBe("line1\nline2");
	});

	it("leaves normal values untouched", () => {
		expect(sanitizeEnvValue("https://app.tripulo.sk")).toBe(
			"https://app.tripulo.sk",
		);
	});

	it("getEnvironmentVariablesObject sanitizes values so a tab can't brick a deploy", () => {
		const obj = getEnvironmentVariablesObject("DISABLE_SIGNUP=fal\tse");
		expect(obj.DISABLE_SIGNUP).toBe("false");
	});
});
