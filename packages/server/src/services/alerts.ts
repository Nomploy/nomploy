import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db";
import {
	type AlertMetric,
	type AlertRule,
	alertEvent,
	alertRule,
	serviceMetricSample,
} from "../db/schema";
import { getLoadBalancerMetricsHistory } from "../setup/loadbalancer-dns";
import { sendClusterAlertNotifications } from "../utils/notifications/cluster-alert";

export type MetricMeta = {
	metric: AlertMetric;
	label: string;
	unit: string;
	needsTarget: boolean;
	defaultComparator: "gt" | "lt";
	defaultThreshold: number;
};

/** Catalogue of alertable metrics shown in the rule editor. */
export const AVAILABLE_METRICS: MetricMeta[] = [
	{
		metric: "lb_5xx_per_sec",
		label: "Load balancer — 5xx / sec",
		unit: "req/s",
		needsTarget: false,
		defaultComparator: "gt",
		defaultThreshold: 1,
	},
	{
		metric: "lb_req_per_sec",
		label: "Load balancer — requests / sec",
		unit: "req/s",
		needsTarget: false,
		defaultComparator: "gt",
		defaultThreshold: 100,
	},
	{
		metric: "lb_latency_ms",
		label: "Load balancer — avg latency",
		unit: "ms",
		needsTarget: false,
		defaultComparator: "gt",
		defaultThreshold: 500,
	},
	{
		metric: "service_cpu_pct",
		label: "Service — CPU used vs reserved",
		unit: "%",
		needsTarget: true,
		defaultComparator: "gt",
		defaultThreshold: 85,
	},
	{
		metric: "service_mem_pct",
		label: "Service — memory used vs reserved",
		unit: "%",
		needsTarget: true,
		defaultComparator: "gt",
		defaultThreshold: 85,
	},
];

const avg = (xs: number[]): number | null =>
	xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Compute a rule's current representative value over its `forMinutes` window. */
const computeValue = async (rule: AlertRule): Promise<number | null> => {
	const minutes = rule.forMinutes;
	if (rule.metric.startsWith("lb_")) {
		const series = await getLoadBalancerMetricsHistory(
			rule.organizationId,
			minutes,
		);
		if (series.length === 0) return null;
		if (rule.metric === "lb_5xx_per_sec")
			return avg(series.map((p) => p.req5xxPerSec));
		if (rule.metric === "lb_req_per_sec")
			return avg(series.map((p) => p.reqPerSec));
		if (rule.metric === "lb_latency_ms")
			return avg(series.map((p) => p.latencyMs));
		return null;
	}

	// Service metrics — scoped to a Nomad job id (appName).
	if (!rule.target) return null;
	const since = new Date(Date.now() - minutes * 60_000).toISOString();
	const rows = await db
		.select()
		.from(serviceMetricSample)
		.where(
			and(
				eq(serviceMetricSample.appName, rule.target),
				gte(serviceMetricSample.createdAt, since),
			),
		);
	if (rows.length === 0) return null;
	const pct = rows
		.map((r) =>
			rule.metric === "service_cpu_pct"
				? r.cpuAllocMhz > 0
					? (r.cpuUsedMhz / r.cpuAllocMhz) * 100
					: null
				: r.memAllocMb > 0
					? (r.memUsedMb / r.memAllocMb) * 100
					: null,
		)
		.filter((x): x is number => x !== null);
	return avg(pct);
};

const metricLabel = (m: string): string =>
	AVAILABLE_METRICS.find((x) => x.metric === m)?.label ?? m;
const metricUnit = (m: string): string =>
	AVAILABLE_METRICS.find((x) => x.metric === m)?.unit ?? "";

/**
 * Evaluate every enabled rule once: compute its value, transition ok↔firing on
 * threshold breach, record an event and notify (via cluster-alert channels) only
 * on a state change. Rules with no data in-window are left unchanged.
 */
export const runAlertEvaluations = async (): Promise<void> => {
	const rules = await db.query.alertRule.findMany({
		where: eq(alertRule.enabled, true),
	});
	for (const rule of rules) {
		try {
			const value = await computeValue(rule);
			if (value === null) continue;
			const violates =
				rule.comparator === "gt"
					? value > rule.threshold
					: value < rule.threshold;
			const nextState = violates ? "firing" : "ok";
			// Always record the latest value; only act on a transition.
			if (nextState === rule.state) {
				await db
					.update(alertRule)
					.set({ lastValue: value })
					.where(eq(alertRule.alertRuleId, rule.alertRuleId));
				continue;
			}

			const unit = metricUnit(rule.metric);
			const label = metricLabel(rule.metric);
			const scope = rule.target ? ` [${rule.target}]` : "";
			const cmp = rule.comparator === "gt" ? ">" : "<";
			const now = new Date();

			await db
				.update(alertRule)
				.set({ state: nextState, lastValue: value, lastStateChangeAt: now })
				.where(eq(alertRule.alertRuleId, rule.alertRuleId));

			await db.insert(alertEvent).values({
				organizationId: rule.organizationId,
				alertRuleId: rule.alertRuleId,
				type: violates ? "fired" : "resolved",
				value,
				message: `${label}${scope} = ${value.toFixed(1)}${unit} (threshold ${cmp} ${rule.threshold}${unit})`,
			});

			await sendClusterAlertNotifications(rule.organizationId, {
				EventType: violates ? "critical" : "recovered",
				Title: violates ? `Alert: ${rule.name}` : `Resolved: ${rule.name}`,
				Message: `${label}${scope} is ${value.toFixed(1)}${unit} (threshold ${cmp} ${rule.threshold}${unit}, sustained ${rule.forMinutes}m).`,
				Timestamp: now.toISOString(),
			}).catch((e) => console.error("alerts: notification failed:", e));
		} catch (e) {
			console.error(`alerts: rule ${rule.alertRuleId} eval failed:`, e);
		}
	}
};

export const startAlertLoop = (intervalSeconds = 60): NodeJS.Timeout => {
	const tick = () => {
		runAlertEvaluations().catch((e) => console.error("alerts: loop error:", e));
	};
	tick();
	return setInterval(tick, intervalSeconds * 1000);
};

/** Recent alert events for an org (newest first). */
export const listAlertEvents = async (organizationId: string, limit = 50) =>
	db.query.alertEvent.findMany({
		where: eq(alertEvent.organizationId, organizationId),
		orderBy: desc(alertEvent.createdAt),
		limit,
	});
