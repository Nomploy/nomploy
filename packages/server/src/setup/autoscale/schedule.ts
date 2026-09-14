import { eq } from "drizzle-orm";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { db } from "../../db";
import { autoscalingSchedule, clusterAutoscaler } from "../../db/schema";
import { reconcileAutoscaler } from "./reconcile";

type ScheduleRow = typeof autoscalingSchedule.$inferSelect;

/**
 * Fire one scheduled action: set the group's desiredNodes (and, when the schedule
 * provides them, override min/max), then reconcile so the actual worker count
 * converges. Re-reads the schedule + group live so edits between fires take
 * effect. Clamps desired to the effective [min,max]. Manual nodes stay pinned.
 */
const applyScheduledAction = async (scheduleId: string) => {
	const s = await db.query.autoscalingSchedule.findFirst({
		where: eq(autoscalingSchedule.scheduleId, scheduleId),
	});
	if (!s || !s.enabled) return;
	const group = await db.query.clusterAutoscaler.findFirst({
		where: eq(clusterAutoscaler.autoscalerId, s.autoscalerId),
		columns: { minNodes: true, maxNodes: true, organizationId: true },
	});
	if (!group) return;
	const min = s.minNodes ?? group.minNodes;
	const max = s.maxNodes ?? group.maxNodes;
	const desired = Math.max(min, Math.min(max, s.desiredNodes));
	await db
		.update(clusterAutoscaler)
		.set({
			desiredNodes: desired,
			...(s.minNodes != null ? { minNodes: s.minNodes } : {}),
			...(s.maxNodes != null ? { maxNodes: s.maxNodes } : {}),
		})
		.where(eq(clusterAutoscaler.autoscalerId, s.autoscalerId));
	await reconcileAutoscaler(group.organizationId, (l) =>
		console.log(`[autoscaler-schedule ${s.name}] ${l.trimEnd()}`),
	).catch((e) => console.error("[autoscaler-schedule]", e));
};

/** (Re)register a schedule's cron job (cancels any existing one first). */
export const scheduleAutoscalingAction = (s: ScheduleRow) => {
	scheduledJobs[s.scheduleId]?.cancel();
	if (!s.enabled) return;
	scheduleJob(
		s.scheduleId,
		{ rule: s.cronExpression, tz: s.timezone || "UTC" },
		() => {
			applyScheduledAction(s.scheduleId).catch((e) =>
				console.error("[autoscaler-schedule]", e),
			);
		},
	);
};

export const removeAutoscalingScheduleJob = (scheduleId: string) => {
	scheduledJobs[scheduleId]?.cancel();
};

/** Re-read + reschedule one action after a create/update. */
export const rescheduleAutoscalingAction = async (scheduleId: string) => {
	const s = await db.query.autoscalingSchedule.findFirst({
		where: eq(autoscalingSchedule.scheduleId, scheduleId),
	});
	if (s) scheduleAutoscalingAction(s);
	else removeAutoscalingScheduleJob(scheduleId);
};

/** Register all enabled schedules at boot. */
export const initAutoscalingSchedules = async (): Promise<number> => {
	const rows = await db.query.autoscalingSchedule.findMany({
		where: eq(autoscalingSchedule.enabled, true),
	});
	for (const s of rows) scheduleAutoscalingAction(s);
	return rows.length;
};
