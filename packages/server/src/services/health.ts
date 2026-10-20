import { eq } from "drizzle-orm";
import { db } from "../db";
import { alertRule } from "../db/schema";
import { getCostSpend } from "./cost";
import {
	findAllBackupsCentralized,
	findAllServicesCentralized,
} from "./overview";
import { getScalingSuggestions } from "./scaling-suggestions";

/**
 * A single cluster-health snapshot for the Monitoring overview: node status,
 * blocked placements, firing alerts, cost projection vs budget, available savings
 * and database backup gaps — each an actionable "is something wrong right now?"
 * signal. Composed from existing services + a couple of direct Nomad reads; every
 * piece is failure-isolated so one slow source doesn't blank the whole card.
 */
const NOMAD = (process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646").replace(
	/\/$/,
	"",
);
const nomad = async <T>(p: string): Promise<T> => {
	const res = await fetch(`${NOMAD}/v1${p}`, {
		headers: process.env.NOMAD_TOKEN
			? { "X-Nomad-Token": process.env.NOMAD_TOKEN }
			: {},
	});
	if (!res.ok) throw new Error(`Nomad ${res.status} on ${p}`);
	return res.json() as Promise<T>;
};

const DB_TYPES = new Set([
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
]);

export interface ClusterHealth {
	currency: string;
	nodes: { total: number; ready: number; down: number; draining: number };
	blockedEvals: number;
	alertsFiring: number;
	cost: {
		runRate: number;
		projectedMonthEnd: number;
		budget: number;
		overBudget: boolean;
	};
	savings: { suggestions: number; potential: number };
	backups: { databases: number; withoutBackup: number };
}

export const getClusterHealth = async (
	orgId: string,
): Promise<ClusterHealth> => {
	// Nodes.
	let nodes = { total: 0, ready: 0, down: 0, draining: 0 };
	try {
		const list = await nomad<
			{ Status: string; SchedulingEligibility: string }[]
		>("/nodes");
		nodes = {
			total: list.length,
			ready: list.filter(
				(n) => n.Status === "ready" && n.SchedulingEligibility === "eligible",
			).length,
			down: list.filter((n) => n.Status !== "ready").length,
			draining: list.filter(
				(n) =>
					n.Status === "ready" && n.SchedulingEligibility !== "eligible",
			).length,
		};
	} catch {}

	// Blocked placements (cluster-wide).
	let blockedEvals = 0;
	try {
		const evals = await nomad<{ Status: string }[]>("/evaluations");
		blockedEvals = evals.filter((e) => e.Status === "blocked").length;
	} catch {}

	// Alert rules currently firing (aggregate or any per-service series).
	let alertsFiring = 0;
	try {
		const rules = await db.query.alertRule.findMany({
			where: eq(alertRule.organizationId, orgId),
		});
		alertsFiring = rules.filter(
			(r) =>
				r.state === "firing" ||
				Object.values(r.seriesState ?? {}).some((v) => v === "firing"),
		).length;
	} catch {}

	// Cost projection vs budget.
	let cost = { runRate: 0, projectedMonthEnd: 0, budget: 0, overBudget: false };
	let currency = "EUR";
	try {
		const spend = await getCostSpend(orgId);
		currency = spend.currency;
		cost = {
			runRate: spend.runRate,
			projectedMonthEnd: spend.projectedMonthEnd,
			budget: spend.budget,
			overBudget: spend.budget > 0 && spend.projectedMonthEnd > spend.budget,
		};
	} catch {}

	// Available savings from the utilization suggestions.
	let savings = { suggestions: 0, potential: 0 };
	try {
		const suggestions = await getScalingSuggestions(orgId);
		savings = {
			suggestions: suggestions.length,
			potential:
				Math.round(
					suggestions.reduce((a, s) => a + s.estMonthlySaving, 0) * 100,
				) / 100,
		};
	} catch {}

	// Database services without a backup configured.
	let backups = { databases: 0, withoutBackup: 0 };
	try {
		const [services, backupRows] = await Promise.all([
			findAllServicesCentralized(orgId, null),
			findAllBackupsCentralized(orgId, null),
		]);
		const backedUp = new Set(backupRows.map((b) => b.serviceId));
		const dbs = services.filter((s) => DB_TYPES.has(s.type));
		backups = {
			databases: dbs.length,
			withoutBackup: dbs.filter((s) => !backedUp.has(s.id)).length,
		};
	} catch {}

	return {
		currency,
		nodes,
		blockedEvals,
		alertsFiring,
		cost,
		savings,
		backups,
	};
};
