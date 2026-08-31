import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "../trpc";

const NOMAD_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const NOMAD_TOKEN = process.env.NOMAD_TOKEN || "";

const nomadFetch = async (path: string) => {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (NOMAD_TOKEN) {
		headers["X-Nomad-Token"] = NOMAD_TOKEN;
	}

	const res = await fetch(`${NOMAD_ADDRESS}/v1${path}`, { headers });
	if (!res.ok) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Nomad API error: ${res.status} ${res.statusText}`,
		});
	}
	return res.json();
};

export const nomadRouter = createTRPCRouter({
	getJobs: withPermission("server", "read")
		.query(async () => {
			return await nomadFetch("/jobs");
		}),

	getJob: withPermission("server", "read")
		.input(z.object({ jobId: z.string() }))
		.query(async ({ input }) => {
			return await nomadFetch(`/job/${input.jobId}`);
		}),

	getJobAllocations: withPermission("server", "read")
		.input(z.object({ jobId: z.string() }))
		.query(async ({ input }) => {
			return await nomadFetch(`/job/${input.jobId}/allocations`);
		}),

	getJobScale: withPermission("server", "read")
		.input(z.object({ jobId: z.string() }))
		.query(async ({ input }) => {
			return await nomadFetch(`/job/${input.jobId}/scale`);
		}),

	getAllocations: withPermission("server", "read")
		.query(async () => {
			return await nomadFetch("/allocations");
		}),

	getAllocation: withPermission("server", "read")
		.input(z.object({ allocId: z.string() }))
		.query(async ({ input }) => {
			return await nomadFetch(`/allocation/${input.allocId}`);
		}),

	getAllocationLogs: withPermission("server", "read")
		.input(z.object({
			allocId: z.string(),
			taskName: z.string(),
			logType: z.enum(["stdout", "stderr"]).default("stdout"),
		}))
		.query(async ({ input }) => {
			const res = await fetch(
				`${NOMAD_ADDRESS}/v1/client/fs/logs/${input.allocId}?task=${input.taskName}&type=${input.logType}&plain=true`,
				{
					headers: NOMAD_TOKEN ? { "X-Nomad-Token": NOMAD_TOKEN } : {},
				},
			);
			if (!res.ok) return "";
			return await res.text();
		}),

	getNodes: withPermission("server", "read")
		.query(async () => {
			return await nomadFetch("/nodes");
		}),

	getClusterResources: withPermission("server", "read")
		.query(async () => {
			const nodes: any[] = await nomadFetch("/nodes");
			const allocs: any[] = await nomadFetch("/allocations?resources=true");

			let totalCpu = 0;
			let totalMemory = 0;
			let totalDisk = 0;
			let allocatedCpu = 0;
			let allocatedMemory = 0;
			let runningAllocs = 0;
			let totalAllocs = allocs.length;

			// Get detailed node info for resources
			for (const node of nodes) {
				if (node.Status !== "ready") continue;
				try {
					const detail: any = await nomadFetch(`/node/${node.ID}`);
					const res = detail.NodeResources || {};
					totalCpu += res.Cpu?.CpuShares || 0;
					totalMemory += res.Memory?.MemoryMB || 0;
					totalDisk += res.Disk?.DiskMB || 0;
				} catch {}
			}

			// Sum allocated resources from running allocations
			for (const alloc of allocs) {
				if (alloc.ClientStatus !== "running") continue;
				runningAllocs++;
				const tasks = alloc.AllocatedResources?.Tasks || {};
				for (const task of Object.values(tasks) as any[]) {
					allocatedCpu += task?.Cpu?.CpuShares || 0;
					allocatedMemory += task?.Memory?.MemoryMB || 0;
				}
			}

			return {
				nodes: nodes.length,
				nodesReady: nodes.filter((n: any) => n.Status === "ready").length,
				cpu: { total: totalCpu, allocated: allocatedCpu, free: totalCpu - allocatedCpu },
				memory: { total: totalMemory, allocated: allocatedMemory, free: totalMemory - allocatedMemory },
				disk: { total: totalDisk },
				allocations: { running: runningAllocs, total: totalAllocs },
			};
		}),

	getNode: withPermission("server", "read")
		.input(z.object({ nodeId: z.string() }))
		.query(async ({ input }) => {
			return await nomadFetch(`/node/${input.nodeId}`);
		}),

	scaleJob: withPermission("server", "create")
		.input(z.object({
			jobId: z.string(),
			group: z.string(),
			count: z.number().min(0),
		}))
		.mutation(async ({ input }) => {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (NOMAD_TOKEN) {
				headers["X-Nomad-Token"] = NOMAD_TOKEN;
			}

			const res = await fetch(
				`${NOMAD_ADDRESS}/v1/job/${input.jobId}/scale`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						Count: input.count,
						Target: {
							Group: input.group,
						},
					}),
				},
			);

			if (!res.ok) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Scale failed: ${res.status}`,
				});
			}
			return await res.json();
		}),

	stopJob: withPermission("server", "create")
		.input(z.object({ jobId: z.string(), purge: z.boolean().default(false) }))
		.mutation(async ({ input }) => {
			const headers: Record<string, string> = {};
			if (NOMAD_TOKEN) {
				headers["X-Nomad-Token"] = NOMAD_TOKEN;
			}

			const res = await fetch(
				`${NOMAD_ADDRESS}/v1/job/${input.jobId}?purge=${input.purge}`,
				{
					method: "DELETE",
					headers,
				},
			);

			if (!res.ok) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Stop failed: ${res.status}`,
				});
			}
			return await res.json();
		}),
});
