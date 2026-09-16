import { createWriteStream } from "node:fs";
import path from "node:path";
import { IS_CLOUD, paths } from "@nomploy/server/constants";
import type { Schedule } from "@nomploy/server/db/schema/schedule";
import {
	createDeploymentSchedule,
	updateDeployment,
	updateDeploymentStatus,
} from "@nomploy/server/services/deployment";
import { findScheduleById } from "@nomploy/server/services/schedule";
import { scheduledJobs, scheduleJob as scheduleJobNode } from "node-schedule";
import { getComposeContainer, getServiceContainer } from "../docker/utils";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { spawnAsync } from "../process/spawnAsync";

export const scheduleJob = (schedule: Schedule) => {
	const { cronExpression, scheduleId, timezone } = schedule;

	// Use timezone from schedule, default to UTC if not specified
	const tz = timezone || "UTC";

	scheduleJobNode(
		scheduleId,
		{
			tz,
			rule: cronExpression,
		},
		async () => {
			await runCommand(scheduleId);
		},
	);
};

export const removeScheduleJob = (scheduleId: string) => {
	const currentJob = scheduledJobs[scheduleId];
	currentJob?.cancel();
};

export const runCommand = async (scheduleId: string) => {
	const {
		application,
		command,
		shellType,
		scheduleType,
		compose,
		serviceName,
		appName,
		serverId,
		scaleCount,
	} = await findScheduleById(scheduleId);

	const deployment = await createDeploymentSchedule({
		scheduleId,
		title: "Schedule",
		description: "Schedule",
	});

	// Scheduled scaling: scale a Nomad service's task group to a fixed count via the
	// Nomad API (the control plane's NOMAD_ADDRESS/NOMAD_TOKEN env). serviceName is
	// the task group; the job id is the linked app/compose appName.
	if (scheduleType === "nomad-scale") {
		const jobId = compose?.appName || application?.appName || "";
		const group = serviceName || "";
		const count = scaleCount ?? 1;
		const body = JSON.stringify({
			Target: { Group: group },
			Count: count,
			Message: "scheduled scale (nomploy)",
		});
		// Single-quote the JSON for the shell; it contains no single quotes.
		const scaleCmd = `
set -e
echo "Scheduled scale: ${jobId} / ${group} -> ${count}" >> ${deployment.logPath}
ADDR="\${NOMAD_ADDRESS:-http://127.0.0.1:4646}"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "X-Nomad-Token: \${NOMAD_TOKEN:-}" -H "Content-Type: application/json" \
  "$ADDR/v1/job/${jobId}/scale" -d '${body}')
if [ "$code" = "200" ]; then
  echo "✅ Scaled ${jobId}/${group} to ${count}" >> ${deployment.logPath}
else
  echo "❌ Scale failed (HTTP $code)" >> ${deployment.logPath}
  exit 1
fi
`;
		try {
			if (serverId) await execAsyncRemote(serverId, scaleCmd);
			else await execAsync(scaleCmd);
			await updateDeploymentStatus(deployment.deploymentId, "done");
		} catch (error) {
			await updateDeploymentStatus(deployment.deploymentId, "error");
			throw error;
		}
		return;
	}

	if (scheduleType === "application" || scheduleType === "compose") {
		let containerId = "";
		let serverId = "";
		if (scheduleType === "application" && application) {
			const container = await getServiceContainer(
				application.appName,
				application.serverId,
			);
			containerId = container?.Id || "";
			serverId = application.serverId || "";
		}
		if (scheduleType === "compose" && compose) {
			const container = await getComposeContainer(compose, serviceName || "");
			containerId = container?.Id || "";
			serverId = compose.serverId || "";
		}

		if (serverId) {
			try {
				await execAsyncRemote(
					serverId,
					`
					set -e
					echo "Running command: docker exec ${containerId} ${shellType} -c '${command}'" >> ${deployment.logPath};
					docker exec ${containerId} ${shellType} -c '${command}' >> ${deployment.logPath} 2>> ${deployment.logPath} || { 
						echo "❌ Command failed" >> ${deployment.logPath};
						exit 1;
					}
					echo "✅ Command executed successfully" >> ${deployment.logPath};
					`,
				);
			} catch (error) {
				await updateDeploymentStatus(deployment.deploymentId, "error");
				throw error;
			}
		} else {
			const writeStream = createWriteStream(deployment.logPath, { flags: "a" });

			try {
				if (IS_CLOUD) {
					writeStream.write(
						"This feature is not available in the cloud version.",
					);
					writeStream.end();
					return;
				}
				writeStream.write(
					`docker exec ${containerId} ${shellType} -c ${command}\n`,
				);
				await spawnAsync(
					"docker",
					["exec", containerId, shellType, "-c", command],
					(data) => {
						if (writeStream.writable) {
							writeStream.write(data);
						}
					},
				);

				writeStream.write("✅ Command executed successfully\n");
			} catch (error) {
				writeStream.write("❌ Command failed\n");
				writeStream.write(
					error instanceof Error ? error.message : "Unknown error",
				);
				writeStream.end();
				await updateDeploymentStatus(deployment.deploymentId, "error");
				throw error;
			}
		}
	} else if (scheduleType === "dokploy-server") {
		try {
			const writeStream = createWriteStream(deployment.logPath, { flags: "a" });
			const { SCHEDULES_PATH } = paths();
			const fullPath = path.join(SCHEDULES_PATH, appName || "");

			await spawnAsync(
				"bash",
				["-c", "./script.sh"],
				async (data) => {
					if (writeStream.writable) {
						// we need to extract the PID and Schedule ID from the data
						const pid = data?.match(/PID: (\d+)/)?.[1];

						if (pid) {
							await updateDeployment(deployment.deploymentId, {
								pid,
							});
						}
						writeStream.write(data);
					}
				},
				{
					cwd: fullPath,
				},
			);
		} catch (error) {
			await updateDeploymentStatus(deployment.deploymentId, "error");
			throw error;
		}
	} else if (scheduleType === "server") {
		try {
			const { SCHEDULES_PATH } = paths(true);
			const fullPath = path.join(SCHEDULES_PATH, appName || "");
			const command = `
				set -e
				echo "Running script" >> ${deployment.logPath};
				bash -c ${fullPath}/script.sh 2>&1 | tee -a ${deployment.logPath} || { 
					echo "❌ Command failed" >> ${deployment.logPath};
					exit 1;
				  }
				echo "✅ Command executed successfully" >> ${deployment.logPath};
			`;
			await execAsyncRemote(serverId, command, async (data) => {
				// we need to extract the PID and Schedule ID from the data
				const pid = data?.match(/PID: (\d+)/)?.[1];
				if (pid) {
					await updateDeployment(deployment.deploymentId, {
						pid,
					});
				}
			});
		} catch (error) {
			await updateDeploymentStatus(deployment.deploymentId, "error");
			throw error;
		}
	}
	await updateDeploymentStatus(deployment.deploymentId, "done");
};
