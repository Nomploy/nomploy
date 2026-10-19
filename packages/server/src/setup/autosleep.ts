import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { applications, compose } from "../db/schema";
import { sleepApplication } from "../services/application";
import { getServiceRequestActivity } from "../services/request-activity";
import { getActivatorConfig } from "./activator";

/**
 * Put a sleeping compose to rest. Composes can't be slept purely server-side (the
 * redeploy goes through the panel's BullMQ queue), so the loop takes this callback
 * from the panel — same split the activator's wake endpoint uses.
 */
export type ComposeSleeper = (composeId: string) => Promise<void>;

/**
 * Auto-idle: scale a scale-to-zero service to 0 once it has had no requests for
 * its configured `idleMinutes`. The wake side is the activator — so this ONLY runs
 * when the activator is enabled; without a wake-on-request path, auto-sleeping
 * would strand the service until a human wakes it, which we refuse to do. (Manual
 * Sleep/Wake is unaffected — a user can still sleep without the activator.)
 *
 * Idle is read from the sampled Traefik request counter (service_request_sample):
 * once a service has served ≥1 request its counter series exists and is sampled
 * every tick with a flat value, so idle grows correctly while it's quiet. A
 * service that has never been requested since Traefik started has no series yet
 * (stays "collecting") and won't auto-sleep until its first request — by design,
 * we don't guess idleness without evidence of traffic.
 */
export const runAutoSleepTick = async (
	sleepCompose: ComposeSleeper,
): Promise<void> => {
	// No wake path → never auto-sleep.
	if (!getActivatorConfig().enabled) return;

	const apps = await db.query.applications.findMany({
		where: and(
			eq(applications.scaleToZeroEnabled, true),
			eq(applications.isSleeping, false),
			// Only a successfully-deployed app — never interrupt a build/deploy.
			eq(applications.applicationStatus, "done"),
		),
		columns: { applicationId: true, appName: true, idleMinutes: true },
	});
	for (const app of apps) {
		try {
			const activity = await getServiceRequestActivity(app.appName);
			if (activity.collecting || activity.idleMinutes === null) continue;
			if (activity.idleMinutes < app.idleMinutes) continue;
			console.log(
				`auto-sleep: application ${app.appName} idle ${activity.idleMinutes}m ≥ ${app.idleMinutes}m → sleeping`,
			);
			await sleepApplication(app.applicationId);
		} catch (e) {
			console.error(`auto-sleep: application ${app.appName} failed:`, e);
		}
	}

	const composes = await db.query.compose.findMany({
		where: and(
			eq(compose.scaleToZeroEnabled, true),
			eq(compose.isSleeping, false),
			eq(compose.composeStatus, "done"),
		),
		columns: { composeId: true, appName: true, idleMinutes: true },
	});
	for (const c of composes) {
		try {
			const activity = await getServiceRequestActivity(c.appName);
			if (activity.collecting || activity.idleMinutes === null) continue;
			if (activity.idleMinutes < c.idleMinutes) continue;
			console.log(
				`auto-sleep: compose ${c.appName} idle ${activity.idleMinutes}m ≥ ${c.idleMinutes}m → sleeping`,
			);
			await sleepCompose(c.composeId);
		} catch (e) {
			console.error(`auto-sleep: compose ${c.appName} failed:`, e);
		}
	}
};

/** Background loop: evaluate auto-sleep every `intervalSeconds` (leader-only). */
export const startAutoSleepLoop = (
	sleepCompose: ComposeSleeper,
	intervalSeconds = 60,
): NodeJS.Timeout => {
	const tick = async () => {
		try {
			await runAutoSleepTick(sleepCompose);
		} catch (e) {
			console.error("auto-sleep: loop error:", e);
		}
	};
	void tick();
	return setInterval(tick, intervalSeconds * 1000);
};
