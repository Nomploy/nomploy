import { beforeEach, describe, expect, it, vi } from "vitest";

// The monitor reads Nomad over HTTP via nomadFetch and appends to the log via the
// exec layer. Mock both: nomadFetch drives the rollout outcome; exec is a no-op.
const nomadFetch = vi.fn();
vi.mock("@nomploy/server/setup/pack-nomad", () => ({
	nomadFetch: (path: string) => nomadFetch(path),
}));
vi.mock("@nomploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => ({ stdout: "", stderr: "" })),
	execAsyncRemote: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

import { monitorNomadRollout } from "@nomploy/server/setup/deploy-monitor";

// The monitor is fire-and-forget; resolve a promise from the finalizer so the test
// awaits the async outcome deterministically.
const runAndAwait = (mode: "job" | "pack" = "job") =>
	new Promise<{ outcome: "success" | "failure"; reason?: string }>(
		(resolve) => {
			monitorNomadRollout({
				appName: "myapp",
				mode,
				logPath: "/tmp/deploy.log",
				deadlineMs: 2000,
				onSuccess: async () => resolve({ outcome: "success" }),
				onFailure: async (reason) => resolve({ outcome: "failure", reason }),
			});
		},
	);

describe("monitorNomadRollout (HTTP-polled, health-aware)", () => {
	beforeEach(() => {
		nomadFetch.mockReset();
	});

	it("onSuccess when the job's deployment is successful", async () => {
		nomadFetch.mockImplementation(async (path: string) => {
			if (path.endsWith("/deployment")) return { Status: "successful" };
			return [];
		});
		const res = await runAndAwait();
		expect(res.outcome).toBe("success");
	});

	it("onFailure when the job's deployment failed", async () => {
		nomadFetch.mockImplementation(async (path: string) => {
			if (path.endsWith("/deployment")) return { Status: "failed" };
			return [];
		});
		const res = await runAndAwait();
		expect(res.outcome).toBe("failure");
		expect(res.reason).toMatch(/healthy/i);
	});

	it("falls back to allocations when there is no deployment (404)", async () => {
		nomadFetch.mockImplementation(async (path: string) => {
			if (path.endsWith("/deployment")) throw new Error("Nomad 404");
			if (path.includes("/allocations"))
				return [{ ClientStatus: "running", JobVersion: 1 }];
			return {};
		});
		const res = await runAndAwait();
		expect(res.outcome).toBe("success");
	});

	it("fails when the only current-version allocs are failed/lost", async () => {
		nomadFetch.mockImplementation(async (path: string) => {
			if (path.endsWith("/deployment")) throw new Error("Nomad 404");
			if (path.includes("/allocations"))
				return [{ ClientStatus: "failed", JobVersion: 2 }];
			return {};
		});
		const res = await runAndAwait();
		expect(res.outcome).toBe("failure");
	});

	it("pack mode resolves job ids via the deployment_name meta", async () => {
		const seen: string[] = [];
		nomadFetch.mockImplementation(async (path: string) => {
			seen.push(path);
			if (path.startsWith("/jobs"))
				return [
					{ ID: "pack-xyz", Meta: { "pack.deployment_name": "myapp" } },
					{ ID: "other", Meta: {} },
				];
			if (path.endsWith("/deployment")) return { Status: "successful" };
			return [];
		});
		const res = await runAndAwait("pack");
		expect(res.outcome).toBe("success");
		expect(seen.some((p) => p.startsWith("/jobs"))).toBe(true);
		// It should query the resolved pack job id, not the appName.
		expect(seen.some((p) => p.includes("pack-xyz"))).toBe(true);
	});
});
