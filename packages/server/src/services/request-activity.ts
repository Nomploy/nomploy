import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { serviceRequestSample } from "../db/schema";

export type RequestActivity = {
	/** Not enough samples yet to say anything. */
	collecting: boolean;
	/** Requests served in the last hour (null while collecting). */
	requestsLastHour: number | null;
	/** Whole minutes since the request counter last increased (null while collecting). */
	idleMinutes: number | null;
};

/**
 * Summarize a service's recent traffic from the sampled Traefik request counter
 * (service_request_sample, written by the LB metrics sampler). Used by the
 * scale-to-zero UI to show "N requests in the last hour · idle X min", and later
 * by auto-sleep. Reads a bounded recent window (newest 500 samples ≈ 8h at the
 * 60s cadence) so a card load stays cheap.
 */
export const getServiceRequestActivity = async (
	appName: string,
): Promise<RequestActivity> => {
	const rows = await db
		.select({
			createdAt: serviceRequestSample.createdAt,
			requests: serviceRequestSample.requests,
		})
		.from(serviceRequestSample)
		.where(eq(serviceRequestSample.appName, appName))
		.orderBy(desc(serviceRequestSample.createdAt))
		.limit(500);

	if (rows.length < 2) {
		return { collecting: true, requestsLastHour: null, idleMinutes: null };
	}

	const now = Date.now();
	const latest = rows[0];
	const oldest = rows[rows.length - 1];
	if (!latest || !oldest) {
		return { collecting: true, requestsLastHour: null, idleMinutes: null };
	}

	// Requests in the last hour: diff the newest counter against the oldest sample
	// still inside the hour window. Clamp a counter reset (Traefik restart) to 0.
	const hourAgo = now - 3600_000;
	const inHour = rows.filter((r) => Date.parse(r.createdAt) >= hourAgo);
	const earliestInHour = inHour[inHour.length - 1];
	const requestsLastHour = earliestInHour
		? Math.max(0, latest.requests - earliestInHour.requests)
		: 0;

	// Idle: walk newest→oldest; the first pair where the counter increased marks
	// the most recent traffic. None found → idle since the oldest sample we have.
	let lastActivityAt: string | null = null;
	for (let i = 0; i < rows.length - 1; i++) {
		const newer = rows[i];
		const older = rows[i + 1];
		if (newer && older && newer.requests > older.requests) {
			lastActivityAt = newer.createdAt;
			break;
		}
	}
	const sinceMs = now - Date.parse(lastActivityAt ?? oldest.createdAt);
	const idleMinutes = Math.max(0, Math.floor(sinceMs / 60000));

	return { collecting: false, requestsLastHour, idleMinutes };
};
