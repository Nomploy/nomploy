import { beforeEach, describe, expect, it, vi } from "vitest";

// A git-sourced compose on a REMOTE server: the clone lives on that server, so the
// builder must read the compose file over SSH (execAsyncRemote) instead of the
// stored composeFile snapshot (which is "" for git sources).
const execAsyncRemote = vi.fn();
vi.mock("@nomploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => ({ stdout: "", stderr: "" })),
	execAsyncRemote: (serverId: string, command: string) =>
		execAsyncRemote(serverId, command),
}));

import { getBuildNomadCommand } from "@nomploy/server/utils/builders/nomad";

const compose = {
	appName: "starring",
	serverId: "srv-1",
	sourceType: "github",
	composePath: "./docker-compose.dokploy.yml",
	composeFile: "",
	env: "",
	environment: { project: { env: "" }, env: null },
	mounts: [],
	domains: [],
} as any;

const decodeJob = (cmd: string) => {
	const match = cmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/);
	return Buffer.from(match?.[1] ?? "", "base64").toString();
};

describe("nomad builder — remote git compose", () => {
	beforeEach(() => {
		execAsyncRemote.mockReset();
	});

	it("reads the cloned compose file from the remote server", async () => {
		execAsyncRemote.mockResolvedValue({
			stdout: "services:\n  web:\n    image: ghcr.io/pipozzz/starring\n",
			stderr: "",
		});
		const cmd = await getBuildNomadCommand(compose);
		const [serverId, command] = execAsyncRemote.mock.calls[0] ?? [];
		expect(serverId).toBe("srv-1");
		expect(command).toMatch(
			/^cat .*starring\/code\/docker-compose\.dokploy\.yml/,
		);
		expect(decodeJob(cmd)).toContain("ghcr.io/pipozzz/starring");
	});

	it("throws a clear error naming the path and server when unreadable", async () => {
		execAsyncRemote.mockRejectedValue(new Error("No such file"));
		await expect(getBuildNomadCommand(compose)).rejects.toThrow(
			/docker-compose\.dokploy\.yml.*on server srv-1/,
		);
	});
});
