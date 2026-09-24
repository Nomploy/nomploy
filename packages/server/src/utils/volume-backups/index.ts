export * from "./backup";
export * from "./restore";
export * from "./utils";

import { volumeBackups } from "@nomploy/server/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db/index";
import { scheduleVolumeBackup } from "./utils";

export const initVolumeBackupsCronJobs = async () => {
	console.log("Setting up volume backups cron jobs....");
	try {
		const volumeBackupsResult = await db.query.volumeBackups.findMany({
			where: eq(volumeBackups.enabled, true),
			with: {
				// Column-trimmed to avoid the >100-arg json_build_array crash on a full
				// application load; this init loop only uses the row id anyway.
				// [[nomploy-json-build-array-100-arg-limit]]
				application: { columns: { appName: true, serverId: true } },
				compose: true,
			},
		});

		console.log(`Initializing ${volumeBackupsResult.length} volume backups`);
		for (const volumeBackup of volumeBackupsResult) {
			scheduleVolumeBackup(volumeBackup.volumeBackupId);
			console.log(
				`Initialized volume backup: ${volumeBackup.name} ${volumeBackup.serviceType} ✅`,
			);
		}
	} catch (error) {
		console.log(`Error initializing volume backups: ${error}`);
	}
};
