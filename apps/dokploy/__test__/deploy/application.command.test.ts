import * as adminService from "@nomploy/server/services/admin";
import * as applicationService from "@nomploy/server/services/application";
import { deployApplication } from "@nomploy/server/services/application";
import * as deploymentService from "@nomploy/server/services/deployment";
import * as builders from "@nomploy/server/utils/builders";
import * as notifications from "@nomploy/server/utils/notifications/build-success";
import * as execProcess from "@nomploy/server/utils/process/execAsync";
import * as gitProvider from "@nomploy/server/utils/providers/git";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@nomploy/server/db", () => {
	const createChainableMock = (): any => {
		const chain = {
			set: vi.fn(() => chain),
			where: vi.fn(() => chain),
			returning: vi.fn().mockResolvedValue([{}] as any),
			from: vi.fn(() => chain),
			innerJoin: vi.fn(() => chain),
			then: (resolve: (v: any) => void) => {
				resolve([]);
			},
		} as any;
		return chain;
	};

	return {
		db: {
			select: vi.fn(() => createChainableMock()),
			insert: vi.fn(),
			update: vi.fn(() => createChainableMock()),
			delete: vi.fn(),
			query: {
				applications: {
					findFirst: vi.fn(),
				},
				patch: {
					findMany: vi.fn().mockResolvedValue([]),
				},
				member: {
					findMany: vi.fn().mockResolvedValue([]),
				},
			},
		},
	};
});

vi.mock("@nomploy/server/services/application", async () => {
	const actual = await vi.importActual<
		typeof import("@nomploy/server/services/application")
	>("@nomploy/server/services/application");
	return {
		...actual,
		findApplicationById: vi.fn(),
		updateApplicationStatus: vi.fn(),
	};
});

vi.mock("@nomploy/server/services/admin", () => ({
	getNomployUrl: vi.fn(),
}));

vi.mock("@nomploy/server/services/deployment", () => ({
	createDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateDeployment: vi.fn(),
}));

vi.mock("@nomploy/server/utils/providers/git", async () => {
	const actual = await vi.importActual<
		typeof import("@nomploy/server/utils/providers/git")
	>("@nomploy/server/utils/providers/git");
	return {
		...actual,
		getGitCommitInfo: vi.fn(),
	};
});

vi.mock("@nomploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	ExecError: class ExecError extends Error {},
}));

vi.mock("@nomploy/server/utils/builders", async () => {
	const actual = await vi.importActual<
		typeof import("@nomploy/server/utils/builders")
	>("@nomploy/server/utils/builders");
	return {
		...actual,
		mechanizeDockerContainer: vi.fn(),
		getBuildCommand: vi.fn(),
	};
});

vi.mock("@nomploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));

vi.mock("@nomploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn(),
}));

vi.mock("@nomploy/server/services/rollbacks", () => ({
	createRollback: vi.fn(),
}));

import { db } from "@nomploy/server/db";
import { cloneGitRepository } from "@nomploy/server/utils/providers/git";

const createMockApplication = (overrides = {}) => ({
	applicationId: "test-app-id",
	name: "Test App",
	appName: "test-app",
	sourceType: "git" as const,
	customGitUrl: "https://github.com/Nomploy/examples.git",
	customGitBranch: "main",
	customGitSSHKeyId: null,
	buildType: "nixpacks" as const,
	buildPath: "/astro",
	env: "NODE_ENV=production",
	serverId: null,
	rollbackActive: false,
	enableSubmodules: false,
	environmentId: "env-id",
	environment: {
		projectId: "project-id",
		env: "",
		name: "production",
		project: {
			name: "Test Project",
			organizationId: "org-id",
			env: "",
		},
	},
	domains: [],
	...overrides,
});

const createMockDeployment = () => ({
	deploymentId: "deployment-id",
	logPath: "/tmp/test-deployment.log",
});

describe("deployApplication - Command Generation Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			createMockApplication() as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			createMockApplication() as any,
		);
		vi.mocked(adminService.getNomployUrl).mockResolvedValue(
			"http://localhost:3000",
		);
		vi.mocked(deploymentService.createDeployment).mockResolvedValue(
			createMockDeployment() as any,
		);
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		vi.mocked(builders.mechanizeDockerContainer).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(applicationService.updateApplicationStatus).mockResolvedValue(
			{} as any,
		);
		vi.mocked(notifications.sendBuildSuccessNotifications).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(gitProvider.getGitCommitInfo).mockResolvedValue({
			message: "test commit",
			hash: "abc123",
		});
		vi.mocked(deploymentService.updateDeployment).mockResolvedValue({} as any);
	});

	it("should generate correct git clone command for astro example", async () => {
		const app = createMockApplication();
		const command = await cloneGitRepository(app);
		console.log(command);

		expect(command).toContain("https://github.com/Nomploy/examples.git");
		expect(command).not.toContain("--recurse-submodules");
		expect(command).toContain("--branch main");
		expect(command).toContain("--depth 1");
		expect(command).toContain("git clone");
	});

	it("should generate git clone with submodules when enabled", async () => {
		const app = createMockApplication({ enableSubmodules: true });
		const command = await cloneGitRepository(app);

		expect(command).toContain("--recurse-submodules");
		expect(command).toContain("https://github.com/Nomploy/examples.git");
	});

	it("should verify nixpacks command is called with correct app", async () => {
		const mockNixpacksCommand = "nixpacks build /path/to/app --name test-app";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockNixpacksCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test deployment",
			descriptionLog: "",
		});

		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				buildType: "nixpacks",
				customGitUrl: "https://github.com/Nomploy/examples.git",
				buildPath: "/astro",
			}),
		);

		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("nixpacks build"),
		);
	});

	it("should verify railpack command includes correct parameters", async () => {
		const mockApp = createMockApplication({ buildType: "railpack" });
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			mockApp as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			mockApp as any,
		);

		const mockRailpackCommand = "railpack prepare /path/to/app";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockRailpackCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Railpack test",
			descriptionLog: "",
		});

		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				buildType: "railpack",
			}),
		);

		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("railpack prepare"),
		);
	});

	it("should execute commands in correct order", async () => {
		const mockNixpacksCommand = "nixpacks build";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockNixpacksCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		});

		const execCalls = vi.mocked(execProcess.execAsync).mock.calls;
		expect(execCalls.length).toBeGreaterThan(0);

		const fullCommand = execCalls[0]?.[0];
		expect(fullCommand).toContain("set -e");
		expect(fullCommand).toContain("git clone");
		expect(fullCommand).toContain("nixpacks build");
	});

	it("should include log redirection in command", async () => {
		const mockCommand = "nixpacks build";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		});

		const execCalls = vi.mocked(execProcess.execAsync).mock.calls;
		const fullCommand = execCalls[0]?.[0];

		expect(fullCommand).toContain(">> /tmp/test-deployment.log 2>&1");
	});
});
