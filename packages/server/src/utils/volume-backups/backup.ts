import path from "node:path";
import { paths } from "@nomploy/server/constants";
import { findComposeById } from "@nomploy/server/services/compose";
import type { findVolumeBackupById } from "@nomploy/server/services/volume-backups";
import {
	getBackupTimestamp,
	getS3Credentials,
	normalizeS3Path,
} from "../backups/utils";
import { NOMAD_APP_SERVICE_NAME } from "../builders/nomad-application";

/**
 * Shell snippets that stop a Nomad task group for a consistent volume backup and
 * restore it afterwards. Captures the group's current desired count from the
 * Nomad API (falling back to `fallbackCount` when curl/python aren't available),
 * scales it to 0, and scales back to that count. Replaces the Swarm-era
 * `docker service update --replicas` scaling, which never matched a Nomad job.
 */
const nomadScaleStopStart = (
	jobId: string,
	group: string,
	fallbackCount: number,
) => {
	const countVar = "VOLUME_BACKUP_SCALE_COUNT";
	const capture = `${countVar}=$(curl -s http://127.0.0.1:4646/v1/job/${jobId}/scale 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('TaskGroups',{}).get('${group}',{}).get('Desired',${fallbackCount}))" 2>/dev/null || echo ${fallbackCount})`;
	return {
		stop: `
		${capture}
		echo "Scaling ${jobId}/${group} to 0 (was $${countVar}) for volume backup"
		nomad job scale ${jobId} ${group} 0`,
		start: `
		echo "Scaling ${jobId}/${group} back to $${countVar}"
		nomad job scale ${jobId} ${group} $${countVar}`,
	};
};

export const getVolumeServiceAppName = (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
): string => {
	if (volumeBackup.compose?.appName) {
		return volumeBackup.serviceName
			? `${volumeBackup.compose.appName}_${volumeBackup.serviceName}`
			: volumeBackup.compose.appName;
	}
	const serviceAppName =
		volumeBackup.application?.appName ||
		volumeBackup.postgres?.appName ||
		volumeBackup.mysql?.appName ||
		volumeBackup.mariadb?.appName ||
		volumeBackup.mongo?.appName ||
		volumeBackup.redis?.appName ||
		volumeBackup.libsql?.appName;
	return serviceAppName || volumeBackup.appName;
};

export const backupVolume = async (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
) => {
	const { serviceType, volumeName, turnOff, prefix } = volumeBackup;
	const serverId =
		volumeBackup.application?.serverId || volumeBackup.compose?.serverId;
	const { VOLUME_BACKUPS_PATH, VOLUME_BACKUP_LOCK_PATH } = paths(!!serverId);
	const destination = volumeBackup.destination;
	const s3AppName = getVolumeServiceAppName(volumeBackup);
	const backupFileName = `${volumeName}-${getBackupTimestamp()}.tar`;
	const bucketDestination = `${s3AppName}/${normalizeS3Path(prefix || "")}${backupFileName}`;
	const rcloneFlags = getS3Credentials(volumeBackup.destination);
	const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;
	const volumeBackupPath = path.join(VOLUME_BACKUPS_PATH, volumeBackup.appName);

	const rcloneCommand = `rclone copyto ${rcloneFlags.join(" ")} "${volumeBackupPath}/${backupFileName}" "${rcloneDestination}"`;

	const backupCommand = `
	set -e
	echo "Volume name: ${volumeName}"
	echo "Backup file name: ${backupFileName}"
	echo "Turning off volume backup: ${turnOff ? "Yes" : "No"}"
	echo "Starting volume backup" 
	echo "Dir: ${volumeBackupPath}"
    docker run --rm \
  -v ${volumeName}:/volume_data \
  -v ${volumeBackupPath}:/backup \
  ubuntu \
  bash -c "cd /volume_data && tar cvf /backup/${backupFileName} ."
  echo "Volume backup done ✅"
  `;

	const uploadCommand = `
  echo "Starting upload to S3..."
  ${rcloneCommand}
  echo "Upload to S3 done ✅"
  echo "Cleaning up local backup file..."
  rm "${volumeBackupPath}/${backupFileName}"
  echo "Local backup file cleaned up ✅"
  `;

	if (!turnOff) {
		return `
		${backupCommand}
		${uploadCommand}
		`;
	}

	const serviceLockId =
		serviceType === "application"
			? volumeBackup.application?.appName
			: `${volumeBackup.compose?.appName}_${volumeBackup.serviceName}`;

	const lockPath = `${VOLUME_BACKUP_LOCK_PATH}-${serviceLockId}`;

	const lockWrapper = (body: string) => `
		set -e

		LOCK_PATH="${lockPath}"

		echo "Waiting for volume backup lock: $LOCK_PATH"

		if command -v flock >/dev/null 2>&1; then
			exec 9>"$LOCK_PATH"
			flock 9
		else
			LOCK_DIR="$LOCK_PATH.dir"
			while ! mkdir "$LOCK_DIR" 2>/dev/null; do
				echo "Waiting for volume backup lock: $LOCK_PATH"
				sleep 5
			done
			trap 'rm -rf "$LOCK_DIR"' EXIT
		fi

		echo "Volume backup lock acquired"

		${body}

		echo "Volume backup lock released"
	`;

	console.log(
		lockWrapper(`
		echo "Volume backup lock acquired"
		echo "Volume backup lock released"
	`),
	);

	if (serviceType === "application") {
		// The application is a Nomad job (id = appName) with a single "app" group.
		const { stop, start } = nomadScaleStopStart(
			volumeBackup.application?.appName || "",
			NOMAD_APP_SERVICE_NAME,
			volumeBackup.application?.replicas ?? 1,
		);
		return lockWrapper(`
		${stop}
        ${backupCommand}
		${start}
		${uploadCommand}
  `);
	}
	if (serviceType === "compose") {
		const compose = await findComposeById(
			volumeBackup.compose?.composeId || "",
		);
		let stopCommand = "";
		let startCommand = "";

		if (compose.composeType === "nomad") {
			// A Nomad compose is one job (id = appName); each service is a task
			// group, so scale the backed-up service's group down and back up.
			const { stop, start } = nomadScaleStopStart(
				compose.appName,
				volumeBackup.serviceName || "",
				1,
			);
			stopCommand = stop;
			startCommand = start;
		} else {
			// Plain docker-compose: stop the specific service container by its
			// compose labels.
			stopCommand = `
			echo "Stopping compose container"
            ID=$(docker ps -q --filter "label=com.docker.compose.project=${compose.appName}" --filter "label=com.docker.compose.service=${volumeBackup.serviceName}")
            docker stop $ID`;

			startCommand = `
            echo "Starting compose container"
            docker start $ID
			echo "Compose container started"
			`;
		}
		return lockWrapper(`
        ${stopCommand}
        ${backupCommand}
        ${startCommand}
		${uploadCommand}
  `);
	}
};
