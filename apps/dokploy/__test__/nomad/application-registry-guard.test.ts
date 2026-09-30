import { assertBuiltImageRunnable } from "@nomploy/server/utils/builders/nomad-application";
import { describe, expect, it } from "vitest";

const base = {
	name: "pipoline",
	appName: "pipoline-ol1asr",
	sourceType: "github",
	registryId: null as string | null,
	buildRegistryId: null as string | null,
};

describe("assertBuiltImageRunnable — registry required for built sources", () => {
	it("throws for a git/built source with no registry", () => {
		expect(() => assertBuiltImageRunnable(base)).toThrow(
			/No container registry/,
		);
	});

	it("names the app and the bare image tag in the message", () => {
		expect(() => assertBuiltImageRunnable(base)).toThrow(
			/pipoline-ol1asr:latest/,
		);
	});

	it("passes when a deploy registry is set", () => {
		expect(() =>
			assertBuiltImageRunnable({ ...base, registryId: "reg_123" }),
		).not.toThrow();
	});

	it("passes when only a build registry is set", () => {
		expect(() =>
			assertBuiltImageRunnable({ ...base, buildRegistryId: "reg_456" }),
		).not.toThrow();
	});

	it("no-ops for a docker (pre-built image) source even without a registry", () => {
		expect(() =>
			assertBuiltImageRunnable({ ...base, sourceType: "docker" }),
		).not.toThrow();
	});

	it("applies to every built source type (gitlab/gitea/bitbucket/git/drop)", () => {
		for (const sourceType of ["gitlab", "gitea", "bitbucket", "git", "drop"]) {
			expect(() => assertBuiltImageRunnable({ ...base, sourceType })).toThrow(
				/No container registry/,
			);
		}
	});
});
