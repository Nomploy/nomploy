import {
	applyCanaryToJob,
	applyDomainsToJob,
	applyNodePoolToJob,
} from "@nomploy/server/setup/pack-domains";
import { describe, expect, it } from "vitest";

// A minimal deployed Nomad-Pack job JSON: one group, one task, one service.
const makeJob = () => ({
	ID: "pack-memos",
	TaskGroups: [
		{
			Name: "app",
			Count: 1,
			Services: [{ Name: "memos", PortLabel: "http" }],
			Tasks: [{ Name: "server", Resources: { CPU: 100, MemoryMB: 128 } }],
		},
	],
});

// biome-ignore lint/suspicious/noExplicitAny: test fixture, not the full Domain row.
const domain = (over: Record<string, unknown> = {}): any => ({
	serviceName: "memos",
	host: "memos.example.com",
	uniqueConfigKey: 1,
	path: "/",
	https: true,
	customCertResolver: null,
	...over,
});

describe("applyNodePoolToJob — pack job JSON patch", () => {
	it("pins the job to a named node pool", () => {
		const job = makeJob() as Record<string, unknown>;
		expect(applyNodePoolToJob(job, "workers")).toBe(true);
		expect(job.NodePool).toBe("workers");
	});

	it("maps null / 'default' to the default pool and is idempotent", () => {
		const job = makeJob() as Record<string, unknown>;
		expect(applyNodePoolToJob(job, null)).toBe(true);
		expect(job.NodePool).toBe("default");
		// already at target → no further change
		expect(applyNodePoolToJob(job, "default")).toBe(false);
		expect(applyNodePoolToJob(job, undefined)).toBe(false);
	});
});

describe("applyCanaryToJob — canary only where a 2nd alloc can coexist", () => {
	// biome-ignore lint/suspicious/noExplicitAny: loose Nomad job fixtures.
	const httpGroup = (over: Record<string, any> = {}): any => ({
		Name: "app",
		Count: 1,
		Services: [{ Name: "app", PortLabel: "http", Tags: ["traefik.enable=true"] }],
		Tasks: [{ Name: "server", Config: {} }],
		Networks: [{ Mode: "bridge", DynamicPorts: [{ Label: "http", To: 8080 }] }],
		...over,
	});

	it("enables canary for a stateless HTTP group on a dynamic port", () => {
		const job = { ID: "pack-app", TaskGroups: [httpGroup()] };
		applyCanaryToJob(job);
		expect(job.TaskGroups[0].Update?.Canary).toBe(1);
		expect(job.TaskGroups[0].Services[0].CanaryTags).toEqual([
			"traefik.enable=false",
		]);
	});

	it("skips canary when the group pins a static host port", () => {
		const job = {
			ID: "pack-app",
			TaskGroups: [
				httpGroup({
					Networks: [
						{ Mode: "host", ReservedPorts: [{ Label: "http", Value: 4321 }] },
					],
				}),
			],
		};
		applyCanaryToJob(job);
		expect(job.TaskGroups[0].Update).toBeUndefined();
		expect(job.TaskGroups[0].Services[0].CanaryTags).toBeUndefined();
	});

	it("skips canary when the group mounts a volume", () => {
		const job = {
			ID: "pack-app",
			TaskGroups: [
				httpGroup({
					Tasks: [{ Name: "server", Config: { mount: { type: "volume" } } }],
				}),
			],
		};
		applyCanaryToJob(job);
		expect(job.TaskGroups[0].Update).toBeUndefined();
	});

	it("leaves non-HTTP groups untouched", () => {
		const job = {
			ID: "pack-app",
			TaskGroups: [httpGroup({ Services: [{ Name: "worker", Tags: [] }] })],
		};
		applyCanaryToJob(job);
		expect(job.TaskGroups[0].Update).toBeUndefined();
	});
});

describe("applyDomainsToJob — per-service CrowdSec enforcement", () => {
	it("attaches the CrowdSec middleware when crowdsecProtect is true", () => {
		const job = makeJob();
		const changed = applyDomainsToJob(job, "pack-memos", [domain()], true);
		expect(changed).toBe(true);
		const tags = job.TaskGroups[0]?.Services[0]?.Tags as string[];
		// both the HTTP and the HTTPS router carry the bouncer middleware
		expect(
			tags.some(
				(t) => t.includes(".middlewares=") && t.includes("crowdsec@file"),
			),
		).toBe(true);
	});

	it("omits the CrowdSec middleware when crowdsecProtect is false (opt-out / global mode)", () => {
		const job = makeJob();
		applyDomainsToJob(job, "pack-memos", [domain()], false);
		const tags = job.TaskGroups[0]?.Services[0]?.Tags as string[];
		expect(tags.some((t) => t.includes("crowdsec@file"))).toBe(false);
		// routing itself is still wired
		expect(tags).toContain("traefik.enable=true");
	});
});
