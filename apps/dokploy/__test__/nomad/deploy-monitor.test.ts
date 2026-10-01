import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the exec layer: the monitor runs the rollout probe via execAsync /
// execAsyncRemote; its exit code (resolve vs reject) drives onSuccess/onFailure.
const execAsync = vi.fn();
const execAsyncRemote = vi.fn();
vi.mock("@nomploy/server/utils/process/execAsync", () => ({
	execAsync: (...args: unknown[]) => execAsync(...args),
	execAsyncRemote: (...args: unknown[]) => execAsyncRemote(...args),
}));

import { monitorNomadRollout } from "@nomploy/server/setup/deploy-monitor";

// The monitor is fire-and-forget. Resolve a promise from the finalizer so the test
// can await the async outcome deterministically.
const runAndAwait = (opts: {
	serverId?: string | null;
	execImpl: () => Promise<unknown>;
	remoteImpl?: () => Promise<unknown>;
}) =>
	new Promise<{ outcome: "success" | "failure"; reason?: string }>(
		(resolve) => {
			execAsync.mockImplementation(opts.execImpl);
			execAsyncRemote.mockImplementation(opts.remoteImpl ?? opts.execImpl);
			monitorNomadRollout({
				appName: "myapp",
				mode: "job",
				serverId: opts.serverId,
				logPath: "/tmp/deploy.log",
				deadlineSec: 1,
				onSuccess: async () => resolve({ outcome: "success" }),
				onFailure: async (reason) => resolve({ outcome: "failure", reason }),
			});
		},
	);

describe("monitorNomadRollout", () => {
	beforeEach(() => {
		execAsync.mockReset();
		execAsyncRemote.mockReset();
	});

	it("calls onSuccess when the probe exits 0 (resolves)", async () => {
		const res = await runAndAwait({ execImpl: async () => ({ stdout: "" }) });
		expect(res.outcome).toBe("success");
		expect(execAsync).toHaveBeenCalledTimes(1);
		expect(execAsyncRemote).not.toHaveBeenCalled();
	});

	it("calls onFailure when the probe exits non-zero (rejects)", async () => {
		const res = await runAndAwait({
			execImpl: async () => {
				throw new Error("probe exit 1");
			},
		});
		expect(res.outcome).toBe("failure");
		expect(res.reason).toMatch(/healthy/i);
	});

	it("uses execAsyncRemote when a serverId is given", async () => {
		const res = await runAndAwait({
			serverId: "srv-1",
			execImpl: async () => ({ stdout: "" }),
		});
		expect(res.outcome).toBe("success");
		expect(execAsyncRemote).toHaveBeenCalledTimes(1);
		expect(execAsync).not.toHaveBeenCalled();
	});

	it("runs the base64'd python rollout probe against the app + log path", async () => {
		let captured = "";
		await runAndAwait({
			execImpl: async (cmd?: unknown) => {
				captured = String(cmd);
				return { stdout: "" };
			},
		});
		expect(captured).toContain("base64 -d | python3 -");
		expect(captured).toContain('"myapp" "job"');
		expect(captured).toContain(">> /tmp/deploy.log");
	});
});
