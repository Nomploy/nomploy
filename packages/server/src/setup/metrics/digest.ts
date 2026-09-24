import { eq } from "drizzle-orm";
import { db } from "../../db";
import { notifications } from "../../db/schema";
import { getScalingSuggestions } from "../../services/scaling-suggestions";
import { sendClusterAlertNotifications } from "../../utils/notifications/cluster-alert";

/**
 * Send a per-org daily digest of utilization/scaling suggestions to every org
 * that has cluster alerts enabled on a notification channel. Best-effort and
 * failure-isolated; silent when an org has no suggestions.
 */
export const sendDailyScalingDigest = async () => {
	const notifs = await db.query.notifications.findMany({
		where: eq(notifications.clusterAlert, true),
		columns: { organizationId: true },
	});
	const orgs = [...new Set(notifs.map((n) => n.organizationId))];
	for (const org of orgs) {
		try {
			const suggestions = await getScalingSuggestions(org);
			if (suggestions.length === 0) continue;
			const detail = suggestions
				.slice(0, 15)
				.map((s) => `• ${s.title} — ${s.message}`)
				.join("\n");
			await sendClusterAlertNotifications(org, {
				EventType: "warning",
				Title: "Utilization & scaling suggestions",
				Message: `${suggestions.length} suggestion(s) from the last 24h of metrics`,
				Detail: detail,
				Timestamp: new Date().toISOString(),
			});
		} catch (e) {
			console.error(`[scaling-digest:${org}]`, e);
		}
	}
};

/**
 * Periodic driver: send the scaling digest once per `intervalSeconds` (daily by
 * default). The first run is delayed an hour so freshly-booted panels have some
 * samples to analyze. Started once from the panel server on boot.
 */
export const startScalingDigestLoop = (
	intervalSeconds = 86400,
): NodeJS.Timeout => {
	setTimeout(
		() => {
			sendDailyScalingDigest().catch((e) =>
				console.error("[scaling-digest]", e),
			);
		},
		60 * 60 * 1000,
	);
	return setInterval(() => {
		sendDailyScalingDigest().catch((e) => console.error("[scaling-digest]", e));
	}, intervalSeconds * 1000);
};
