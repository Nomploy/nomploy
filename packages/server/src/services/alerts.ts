import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db";
import {
	type AlertMetric,
	type AlertRule,
	alertEvent,
	alertRule,
	projects,
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

export type MetricPoint = { ts: number; value: number };

/**
 * Time series for a single metric over the last `minutes` — powers the rule
 * editor's live preview chart and per-rule graphs. Works for both LB pool metrics
 * (from the sampled history) and service CPU/mem % (from service_metric_sample).
 */
export const getMetricHistory = async (
	organizationId: string,
	metric: string,
	target: string | null | undefined,
	minutes: number,
): Promise<{ points: MetricPoint[]; unit: string }> => {
	const unit = metricUnit(metric);
	if (metric.startsWith("lb_")) {
		const series = await getLoadBalancerMetricsHistory(organizationId, minutes);
		const pick = (p: {
			reqPerSec: number;
			req5xxPerSec: number;
			latencyMs: number;
		}) =>
			metric === "lb_5xx_per_sec"
				? p.req5xxPerSec
				: metric === "lb_req_per_sec"
					? p.reqPerSec
					: p.latencyMs;
		return { points: series.map((p) => ({ ts: p.ts, value: pick(p) })), unit };
	}
	if (!target) return { points: [], unit };
	const since = new Date(Date.now() - minutes * 60_000).toISOString();
	const rows = await db.query.serviceMetricSample.findMany({
		where: and(
			eq(serviceMetricSample.appName, target),
			gte(serviceMetricSample.createdAt, since),
		),
	});
	const points = rows
		.map((r) => ({
			ts: new Date(r.createdAt).getTime(),
			value:
				metric === "service_cpu_pct"
					? r.cpuAllocMhz > 0
						? (r.cpuUsedMhz / r.cpuAllocMhz) * 100
						: 0
					: r.memAllocMb > 0
						? (r.memUsedMb / r.memAllocMb) * 100
						: 0,
		}))
		.sort((a, b) => a.ts - b.ts);
	return { points, unit };
};

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
				EventType: violates
					? rule.severity === "critical"
						? "critical"
						: "warning"
					: "recovered",
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

export type AlertTarget = { appName: string; label: string };

/**
 * The org's services, as alert-rule targets (value = the Nomad job id / appName).
 * Mirrors the scaling-suggestions service enumeration so service metrics can be
 * picked from a list instead of typed.
 */
export const listAlertTargets = async (
	organizationId: string,
): Promise<AlertTarget[]> => {
	const rows = await db.query.projects.findMany({
		where: eq(projects.organizationId, organizationId),
		columns: { name: true },
		with: {
			environments: {
				columns: { environmentId: true },
				with: {
					applications: { columns: { appName: true, name: true } },
					compose: { columns: { appName: true, name: true } },
					postgres: { columns: { appName: true, name: true } },
					mysql: { columns: { appName: true, name: true } },
					mariadb: { columns: { appName: true, name: true } },
					mongo: { columns: { appName: true, name: true } },
					redis: { columns: { appName: true, name: true } },
					libsql: { columns: { appName: true, name: true } },
				},
			},
		},
	});
	const out: AlertTarget[] = [];
	for (const p of rows) {
		for (const env of p.environments) {
			const add = (svc: { appName: string; name: string }, type: string) => {
				if (svc.appName)
					out.push({
						appName: svc.appName,
						label: `${p.name} / ${svc.name} (${type})`,
					});
			};
			for (const s of env.applications) add(s, "app");
			for (const s of env.compose) add(s, "compose");
			for (const s of env.postgres) add(s, "postgres");
			for (const s of env.mysql) add(s, "mysql");
			for (const s of env.mariadb) add(s, "mariadb");
			for (const s of env.mongo) add(s, "mongo");
			for (const s of env.redis) add(s, "redis");
			for (const s of env.libsql) add(s, "libsql");
		}
	}
	return out.sort((a, b) => a.label.localeCompare(b.label));
};

/** Recent alert events for an org (newest first). */
export const listAlertEvents = async (organizationId: string, limit = 50) =>
	db.query.alertEvent.findMany({
		where: eq(alertEvent.organizationId, organizationId),
		orderBy: desc(alertEvent.createdAt),
		limit,
	});
