import { eq } from "drizzle-orm";
import { db } from "../db";
import { notifications } from "../db/schema";
import { computeCostReport, getCostSpend } from "../services/cost";
import { getScalingSuggestions } from "../services/scaling-suggestions";
import { sendClusterAlertNotifications } from "../utils/notifications/cluster-alert";

/**
 * Weekly cost digest to every org with cluster alerts enabled: current run-rate,
 * month-to-date spend + end-of-month projection vs the budget, the top projects by
 * cost, and the biggest savings still available from the utilization suggestions.
 * Best-effort + failure-isolated; skipped for an org with no priced nodes.
 */
export const sendCostDigest = async (): Promise<void> => {
	const notifs = await db.query.notifications.findMany({
		where: eq(notifications.clusterAlert, true),
		columns: { organizationId: true },
	});
	const orgs = [...new Set(notifs.map((n) => n.organizationId))];
	for (const org of orgs) {
		try {
			const spend = await getCostSpend(org);
			if (spend.runRate <= 0) continue; // nothing priced yet
			const cur = spend.currency;
			const report = await computeCostReport(org, null);
			const suggestions = await getScalingSuggestions(org);
			const savings = suggestions
				.filter((s) => s.estMonthlySaving > 0)
				.sort((a, b) => b.estMonthlySaving - a.estMonthlySaving);
			const totalSavings =
				Math.round(
					savings.reduce((s, x) => s + x.estMonthlySaving, 0) * 100,
				) / 100;

			const overBudget =
				spend.budget > 0 && spend.projectedMonthEnd > spend.budget;
			const budgetLine =
				spend.budget > 0
					? `Budget ${spend.budget} ${cur} — projected uses ${Math.round(
							spend.budgetUsedFraction * 100,
						)}%${overBudget ? " ⚠️ over budget" : ""}`
					: "No budget set";

			const topProjects = report.projects
				.slice(0, 5)
				.map((p) => `• ${p.projectName}: ${p.monthly} ${cur}/mo`)
				.join("\n");
			const topSavings = savings
				.slice(0, 5)
				.map((s) => `• ${s.title}: save ~${s.estMonthlySaving} ${cur}/mo`)
				.join("\n");

			const detail = [
				`Run-rate: ${spend.runRate} ${cur}/mo`,
				`Month-to-date (day ${spend.daysElapsed}/${spend.daysInMonth}): ${spend.monthToDate} ${cur}`,
				`Projected month-end: ${spend.projectedMonthEnd} ${cur}`,
				budgetLine,
				"",
				"Top projects:",
				topProjects || "• (none)",
				...(savings.length > 0
					? [
							"",
							`Available savings: ~${totalSavings} ${cur}/mo`,
							topSavings,
						]
					: []),
			].join("\n");

			await sendClusterAlertNotifications(org, {
				EventType: overBudget ? "warning" : "recovered",
				Title: "Weekly cost report",
				Message: `${spend.projectedMonthEnd} ${cur} projected this month${
					totalSavings > 0 ? ` · ~${totalSavings} ${cur}/mo in savings available` : ""
				}`,
				Detail: detail,
				Timestamp: new Date().toISOString(),
			});
		} catch (e) {
			console.error(`[cost-digest:${org}]`, e);
		}
	}
};

/**
 * Periodic driver: send the cost digest once per `intervalSeconds` (weekly by
 * default). The first run is delayed an hour so a freshly-booted panel has samples.
 */
export const startCostDigestLoop = (
	intervalSeconds = 7 * 86400,
): NodeJS.Timeout => {
	setTimeout(
		() => {
			sendCostDigest().catch((e) => console.error("[cost-digest]", e));
		},
		60 * 60 * 1000,
	);
	return setInterval(() => {
		sendCostDigest().catch((e) => console.error("[cost-digest]", e));
	}, intervalSeconds * 1000);
};
