import {
	applyScalingToJob,
	type PackScalingCompose,
} from "@nomploy/server/setup/pack-scaling";
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

const base: PackScalingCompose = {
	serviceScaling: null,
	deployMode: "shared",
	autoscalingEnabled: false,
	minReplicas: 1,
	maxReplicas: 3,
	autoscaleCpuTarget: null,
	autoscaleMemoryTarget: null,
};

describe("applyScalingToJob — pack job JSON patch", () => {
	it("does nothing when there are no overrides", () => {
		const job = makeJob();
		expect(applyScalingToJob(job, base)).toBe(false);
		expect(job.TaskGroups[0]?.Count).toBe(1);
		expect(job.TaskGroups[0]?.Tasks[0]?.Resources).toEqual({
			CPU: 100,
			MemoryMB: 128,
		});
	});

	it("applies per-service reserved-resource overrides to the task (both modes)", () => {
		const job = makeJob();
		const changed = applyScalingToJob(job, {
			...base,
			serviceScaling: {
				memos: { resources: { cpu: 500, memory: 512, memoryMax: 1024 } },
			},
		});
		expect(changed).toBe(true);
		expect(job.TaskGroups[0]?.Tasks[0]?.Resources).toEqual({
			CPU: 500,
			MemoryMB: 512,
			MemoryMaxMB: 1024,
		});
		// no autoscaling requested → no Scaling stanza, count untouched
		expect(
			(job.TaskGroups[0] as Record<string, unknown>).Scaling,
		).toBeUndefined();
		expect(job.TaskGroups[0]?.Count).toBe(1);
	});

	it("whole-app (shared) autoscaling adds a Scaling policy and starts at min", () => {
		const job = makeJob();
		const changed = applyScalingToJob(job, {
			...base,
			autoscalingEnabled: true,
			minReplicas: 2,
			maxReplicas: 5,
			autoscaleCpuTarget: 65,
		});
		expect(changed).toBe(true);
		const tg = job.TaskGroups[0] as Record<string, any>;
		expect(tg.Count).toBe(2); // starts at min
		expect(tg.Scaling.Min).toBe(2);
		expect(tg.Scaling.Max).toBe(5);
		expect(tg.Scaling.Enabled).toBe(true);
		// matches the HCL builder's nomad-apm target-value policy
		expect(tg.Scaling.Policy.check.cpu.source).toBe("nomad-apm");
		expect(tg.Scaling.Policy.check.cpu.query).toBe("avg_cpu-allocated");
		expect(tg.Scaling.Policy.check.cpu.strategy["target-value"].target).toBe(
			65,
		);
	});

	it("defaults a 70% CPU target when autoscaling is on with no target", () => {
		const job = makeJob();
		applyScalingToJob(job, { ...base, autoscalingEnabled: true });
		const tg = job.TaskGroups[0] as Record<string, any>;
		expect(tg.Scaling.Policy.check.cpu.strategy["target-value"].target).toBe(
			70,
		);
	});

	it("independent mode sets a fixed group Count from per-service replicas", () => {
		const job = makeJob();
		const changed = applyScalingToJob(job, {
			...base,
			deployMode: "independent",
			serviceScaling: { memos: { replicas: 4 } },
		});
		expect(changed).toBe(true);
		expect(job.TaskGroups[0]?.Count).toBe(4);
		expect(
			(job.TaskGroups[0] as Record<string, unknown>).Scaling,
		).toBeUndefined();
	});

	it("shared-mode autoscaling is ignored in independent mode (no whole-app policy)", () => {
		const job = makeJob();
		// autoscalingEnabled is the SHARED-mode field; in independent mode it must
		// not add a group policy on its own.
		const changed = applyScalingToJob(job, {
			...base,
			deployMode: "independent",
			autoscalingEnabled: true,
		});
		expect(changed).toBe(false);
		expect(
			(job.TaskGroups[0] as Record<string, unknown>).Scaling,
		).toBeUndefined();
	});
});
