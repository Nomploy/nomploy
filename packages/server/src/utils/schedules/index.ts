import { schedules } from "@nomploy/server/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db/index";
import { scheduleJob } from "./utils";

export const initSchedules = async () => {
	try {
		const schedulesResult = await db.query.schedules.findMany({
			where: eq(schedules.enabled, true),
			with: {
				server: true,
				// Column-trimmed: a full application relation load serializes >100
				// columns into json_build_array and Postgres rejects it (>100 args).
				// scheduleJob only needs appName + serverId. [[nomploy-json-build-array-100-arg-limit]]
				application: { columns: { appName: true, serverId: true } },
				compose: true,
				organization: true,
			},
		});

		console.log(`Initializing ${schedulesResult.length} schedules`);
		for (const schedule of schedulesResult) {
			scheduleJob(schedule);
			console.log(
				`Initialized schedule: ${schedule.name} ${schedule.scheduleType} ✅`,
			);
		}
	} catch (error) {
		console.log(`Error initializing schedules: ${error}`);
	}
};
