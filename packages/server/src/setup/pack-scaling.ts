import type { compose as composeTable } from "../db/schema";
import { type NomadJob, patchPackJobs } from "./pack-nomad";

type Compose = typeof composeTable.$inferSelect;

// The compose fields the scaling patch reads (the panel's Scaling card writes them).
export type PackScalingCompose = Pick<
	Compose,
	| "serviceScaling"
	| "deployMode"
	| "autoscalingEnabled"
	| "minReplicas"
	| "maxReplicas"
	| "autoscaleCpuTarget"
	| "autoscaleMemoryTarget"
>;

type ServiceConfig = NonNullable<Compose["serviceScaling"]>[string];

type ResolvedAutoscale = {
	min: number;
	max: number;
	cpuTarget?: number;
	memoryTarget?: number;
};

/**
 * The Nomad Autoscaler policy for a target-value horizontal policy — the JSON
 * equivalent of the HCL `policy { check "cpu" { source="nomad-apm" … } }` block
 * the compose builder emits (see generateScalingBlock in builders/nomad.ts), so a
 * patched pack scales through the SAME nomad-apm autoscaler.
 */
const buildScalingPolicy = (a: ResolvedAutoscale) => {
	const check: Record<string, unknown> = {};
	if (a.cpuTarget) {
		check.cpu = {
			source: "nomad-apm",
			query: "avg_cpu-allocated",
			strategy: { "target-value": { target: a.cpuTarget } },
		};
	}
	if (a.memoryTarget) {
		check.memory = {
			source: "nomad-apm",
			query: "avg_memory-allocated",
			strategy: { "target-value": { target: a.memoryTarget } },
		};
	}
	return { check };
};

const buildGroupScaling = (a: ResolvedAutoscale) => ({
	Min: a.min,
	Max: a.max,
	Enabled: true,
	Type: "horizontal",
	Policy: buildScalingPolicy(a),
});

/** Resolve an autoscaling override to concrete min/max/target, defaulting a 70%
 * CPU target when enabled with none set (mirrors the builder + the app UI). */
const resolveAutoscale = (
	auto: NonNullable<ServiceConfig["autoscaling"]>,
): ResolvedAutoscale => {
	const min = Math.max(1, auto.min);
	const hasTarget = auto.cpuTarget != null || auto.memoryTarget != null;
	return {
		min,
		max: Math.max(min, auto.max),
		cpuTarget: auto.cpuTarget ?? (hasTarget ? undefined : 70),
		memoryTarget: auto.memoryTarget ?? undefined,
	};
};

const svcNames = (arr: NomadJob[] | undefined): string[] =>
	(arr ?? []).map((s) => s?.Name).filter((n): n is string => !!n);

/**
 * Apply the panel's scaling overrides to one deployed pack job, in place. Packs
 * render their job from a template on every `nomad-pack run`, so this only ever
 * ADDS overrides onto the fresh template (no need to clear stale ones):
 *
 *  - Reserved resources (both modes, per task): a task inherits the override keyed
 *    by any service it (or its group) registers → set CPU / MemoryMB / MemoryMaxMB.
 *  - Independent mode: per-service replicas → group Count; per-service autoscaling
 *    → group Count=min + a Scaling policy.
 *  - Shared mode: whole-app autoscaling → a Scaling policy on every group.
 *
 * Returns whether the job changed. Keyed by Consul service name, matching
 * loadPackServices (what the Scaling card lists).
 */
export const applyScalingToJob = (
	job: NomadJob,
	compose: PackScalingCompose,
): boolean => {
	const overrides = (compose.serviceScaling ?? {}) as Record<
		string,
		ServiceConfig
	>;
	const independent = compose.deployMode === "independent";
	// Shared-mode whole-app autoscaling → applied to every group.
	const groupAuto: ResolvedAutoscale | undefined =
		!independent && compose.autoscalingEnabled
			? resolveAutoscale({
					enabled: true,
					min: compose.minReplicas ?? 1,
					max: compose.maxReplicas ?? 3,
					cpuTarget: compose.autoscaleCpuTarget ?? undefined,
					memoryTarget: compose.autoscaleMemoryTarget ?? undefined,
				})
			: undefined;

	let changed = false;
	for (const tg of job.TaskGroups ?? []) {
		const groupSvcNames = [
			...svcNames(tg.Services),
			...(tg.Tasks ?? []).flatMap((t: NomadJob) => svcNames(t.Services)),
		];

		// Reserved-resource overrides, per task (matched by the task's own services,
		// or the group's services for a single-task group).
		for (const task of tg.Tasks ?? []) {
			const names = [...svcNames(task.Services), ...svcNames(tg.Services)];
			const o = names.map((n) => overrides[n]).find((x) => x?.resources);
			if (o?.resources) {
				task.Resources = task.Resources ?? {};
				if (o.resources.cpu != null) task.Resources.CPU = o.resources.cpu;
				if (o.resources.memory != null)
					task.Resources.MemoryMB = o.resources.memory;
				if (o.resources.memoryMax != null)
					task.Resources.MemoryMaxMB = o.resources.memoryMax;
				changed = true;
			}
		}

		// Count / autoscaling. Independent: the first service override in the group
		// that carries replicas/autoscaling wins. Shared: the whole-app policy.
		const perSvc = independent
			? groupSvcNames
					.map((n) => overrides[n])
					.find((o) => o && (o.replicas != null || o.autoscaling))
			: undefined;
		const perSvcAuto = perSvc?.autoscaling;
		const auto: ResolvedAutoscale | undefined = perSvcAuto?.enabled
			? resolveAutoscale(perSvcAuto)
			: groupAuto;

		if (auto) {
			tg.Count = auto.min; // autoscaled group starts at min; the autoscaler takes over
			tg.Scaling = buildGroupScaling(auto);
			changed = true;
		} else if (perSvc?.replicas != null) {
			tg.Count = perSvc.replicas;
			changed = true;
		}
	}
	return changed;
};

/**
 * Apply the panel's scaling overrides to a pack deployment's jobs and
 * re-register. Standalone form; the deploy path uses applyPackJobPatches to
 * combine this with the domain tags in a single re-registration.
 */
export const applyPackScaling = async (
	compose: PackScalingCompose & { appName: string },
): Promise<void> => {
	await patchPackJobs(compose.appName, (job) =>
		applyScalingToJob(job, compose),
	);
};
