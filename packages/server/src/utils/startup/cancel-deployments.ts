import { deployments } from "@nomploy/server/db/schema";
import {
	findApplicationById,
	updateApplicationStatus,
} from "@nomploy/server/services/application";
import {
	findComposeById,
	updateCompose,
} from "@nomploy/server/services/compose";
import { updateDeploymentStatus } from "@nomploy/server/services/deployment";
import { monitorNomadRollout } from "@nomploy/server/setup/deploy-monitor";
import { eq } from "drizzle-orm";
import { db } from "../../db/index";

/**
 * On boot, any deployment left in "running" lost its in-process watcher when the
 * previous process died. Historically these were all marked "cancelled". But the
 * detached-rollout deploy path (deploy/rebuild of an application, or a composeType
 * "nomad" compose — see setup/deploy-monitor) registers the job and then watches the
 * rollout OFF the deployment queue; such a deployment is legitimately "running" for
 * up to the monitor window, so a panel roll that overlaps it would wrongly cancel a
 * perfectly healthy rollout.
 *
 * So instead of blanket-cancelling, RE-ATTACH a monitor for those detached deploys
 * (which resolves them to done/error from Nomad's current state — no notifications,
 * since the deploy is from a previous process), and only cancel the rest (previews,
 * schedules, rollbacks, packs, docker-compose — none of which detach).
 */
export const initCancelDeployments = async () => {
	try {
		console.log("Reconciling in-flight deployments…");
		const running = await db.query.deployments.findMany({
			where: eq(deployments.status, "running"),
		});

		let reattached = 0;
		let cancelled = 0;
		for (const dep of running) {
			// Previews / schedules / rollbacks never detach — a "running" one is a true
			// orphan. Cancel it (old behavior).
			const isSpecial =
				!!dep.previewDeploymentId || !!dep.scheduleId || !!dep.rollbackId;

			let reattach: {
				appName: string;
				serverId: string | null;
				onSuccess: () => Promise<void>;
				onFailure: () => Promise<void>;
			} | null = null;

			if (!isSpecial && dep.applicationId) {
				const app = await findApplicationById(dep.applicationId).catch(
					() => null,
				);
				if (app) {
					const applicationId = dep.applicationId;
					reattach = {
						appName: app.appName,
						serverId: app.serverId,
						onSuccess: async () => {
							await updateDeploymentStatus(dep.deploymentId, "done");
							await updateApplicationStatus(applicationId, "done");
						},
						onFailure: async () => {
							await updateDeploymentStatus(dep.deploymentId, "error");
							await updateApplicationStatus(applicationId, "error");
						},
					};
				}
			} else if (!isSpecial && dep.composeId) {
				const compose = await findComposeById(dep.composeId).catch(() => null);
				// Only composeType "nomad" detaches; pack / docker-compose finalize
				// synchronously, so a "running" one of those is a true orphan.
				if (compose && compose.composeType === "nomad") {
					const composeId = dep.composeId;
					reattach = {
						appName: compose.appName,
						serverId: compose.serverId,
						onSuccess: async () => {
							await updateDeploymentStatus(dep.deploymentId, "done");
							await updateCompose(composeId, { composeStatus: "done" });
						},
						onFailure: async () => {
							await updateDeploymentStatus(dep.deploymentId, "error");
							await updateCompose(composeId, { composeStatus: "error" });
						},
					};
				}
			}

			if (reattach) {
				monitorNomadRollout({
					appName: reattach.appName,
					mode: "job",
					serverId: reattach.serverId,
					logPath: dep.logPath,
					onSuccess: reattach.onSuccess,
					onFailure: reattach.onFailure,
				});
				reattached++;
			} else {
				await updateDeploymentStatus(dep.deploymentId, "cancelled");
				cancelled++;
			}
		}

		console.log(
			`Deployments reconciled: ${reattached} re-monitored, ${cancelled} cancelled`,
		);
	} catch (error) {
		console.error(error);
	}
};
