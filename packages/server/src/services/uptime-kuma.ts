import { eq } from "drizzle-orm";
import { db } from "../db";
import type { UptimeKuma } from "../db/schema";
import { uptimeKuma } from "../db/schema";
import {
	type KumaSession,
	testUptimeKuma,
	type UptimeKumaConn,
	withUptimeKuma,
} from "../utils/monitoring/uptime-kuma-client";

// Generated default hosts are throwaway preview URLs — never worth an external
// uptime monitor. Mirrors the check in routers/project.ts.
const isGeneratedDefaultHost = (host: string): boolean =>
	/\.(sslip\.io|traefik\.me)$/i.test(host);

const connOf = (row: UptimeKuma): UptimeKumaConn => ({
	baseUrl: row.baseUrl,
	username: row.username,
	password: row.password,
});

/** The stored connection row (with secret) — internal use only. */
const getRow = (organizationId: string): Promise<UptimeKuma | undefined> =>
	db.query.uptimeKuma.findFirst({
		where: eq(uptimeKuma.organizationId, organizationId),
	});

/** Masked config for the UI (never returns the password). */
export const getUptimeKuma = async (organizationId: string) => {
	const row = await getRow(organizationId);
	if (!row) return null;
	const { password, ...rest } = row;
	return { ...rest, hasPassword: !!password };
};

/**
 * Save (create or update) the external Uptime Kuma connection and verify it by
 * logging in. On update, an empty `password` keeps the stored one. Enables the
 * integration on a successful connect.
 */
export const connectUptimeKuma = async (
	organizationId: string,
	input: {
		baseUrl: string;
		username: string;
		password?: string;
		autoMonitor?: boolean;
	},
): Promise<{ monitorCount: number }> => {
	const existing = await getRow(organizationId);
	const password =
		input.password && input.password.length > 0
			? input.password
			: (existing?.password ?? "");
	if (!password)
		throw new Error("A password is required to connect Uptime Kuma");

	// Verify credentials before persisting the enable flag.
	const monitorCount = await testUptimeKuma({
		baseUrl: input.baseUrl,
		username: input.username,
		password,
	});

	const values = {
		organizationId,
		baseUrl: input.baseUrl,
		username: input.username,
		password,
		enabled: true,
		autoMonitor: input.autoMonitor ?? existing?.autoMonitor ?? true,
		lastSyncStatus: "Connected",
		lastSyncAt: new Date(),
	};

	if (existing) {
		await db
			.update(uptimeKuma)
			.set(values)
			.where(eq(uptimeKuma.organizationId, organizationId));
	} else {
		await db.insert(uptimeKuma).values(values);
	}
	return { monitorCount };
};

export const updateUptimeKumaSettings = async (
	organizationId: string,
	patch: { enabled?: boolean; autoMonitor?: boolean },
): Promise<void> => {
	await db
		.update(uptimeKuma)
		.set(patch)
		.where(eq(uptimeKuma.organizationId, organizationId));
};

export const removeUptimeKuma = async (
	organizationId: string,
): Promise<void> => {
	await db
		.delete(uptimeKuma)
		.where(eq(uptimeKuma.organizationId, organizationId));
};

// ---------------------------------------------------------------------------
// Desired monitors == the org's custom (non-generated) domain hosts
// ---------------------------------------------------------------------------

type DesiredMonitor = { host: string; url: string };

/**
 * The hosts worth monitoring for an org: every custom domain host across its
 * apps + composes (generated preview hosts excluded), de-duplicated by host and
 * preferring the https scheme. Column-trimmed to dodge Postgres's 100-arg
 * json_build_array cap (see loadbalancer-dns.ts), reaching the org via the
 * application/compose → environment → project chain.
 */
const getDesiredMonitors = async (
	organizationId: string,
): Promise<DesiredMonitor[]> => {
	const rows = await db.query.domains.findMany({
		columns: { host: true, https: true },
		with: {
			application: {
				columns: { applicationId: true, uptimeKumaEnabled: true },
				with: {
					environment: {
						columns: { environmentId: true },
						with: { project: { columns: { organizationId: true } } },
					},
				},
			},
			compose: {
				columns: { composeId: true, uptimeKumaEnabled: true },
				with: {
					environment: {
						columns: { environmentId: true },
						with: { project: { columns: { organizationId: true } } },
					},
				},
			},
		},
	});
	// host → prefers an https entry over http.
	const byHost = new Map<string, DesiredMonitor>();
	for (const d of rows) {
		const org =
			d.application?.environment?.project?.organizationId ??
			d.compose?.environment?.project?.organizationId;
		if (org !== organizationId || !d.host) continue;
		if (isGeneratedDefaultHost(d.host)) continue;
		// Per-service opt-out: skip domains of a service that turned monitoring off.
		if (
			d.application?.uptimeKumaEnabled === false ||
			d.compose?.uptimeKumaEnabled === false
		)
			continue;
		const url = `${d.https ? "https" : "http"}://${d.host}`;
		const prev = byHost.get(d.host);
		if (!prev || (d.https && prev.url.startsWith("http://"))) {
			byHost.set(d.host, { host: d.host, url });
		}
	}
	return [...byHost.values()];
};

// ---------------------------------------------------------------------------
// Reconcile: Uptime Kuma monitors <-> pointed domains
// ---------------------------------------------------------------------------

/**
 * Make Uptime Kuma's monitors match the org's custom domains: create a monitor
 * for every host that lacks one, and delete the monitors Nomploy previously
 * created for hosts that are gone. Only ever deletes monitors recorded in
 * {@link UptimeKuma.managedMonitors} — a monitor the user added by hand (even for
 * the same URL) is adopted-by-skip (never duplicated, never deleted).
 */
export const syncUptimeKumaMonitors = async (
	organizationId: string,
): Promise<{ added: number; removed: number; total: number } | null> => {
	const row = await getRow(organizationId);
	if (!row || !row.enabled || !row.autoMonitor) return null;

	const desired = await getDesiredMonitors(organizationId);
	const desiredByHost = new Map(desired.map((d) => [d.host, d]));
	const managed: Record<string, number> = { ...(row.managedMonitors ?? {}) };

	let added = 0;
	let removed = 0;

	const result = await withUptimeKuma(connOf(row), async (s: KumaSession) => {
		const existingUrls = new Set(
			s.monitors.map((m) => (m.url ?? "").replace(/\/$/, "")),
		);
		const existingIds = new Set(s.monitors.map((m) => m.id));
		// Wire created monitors to the "Default" notifications (opt-out) so they
		// actually alert, and tag them "nomploy" so they're identifiable in Kuma.
		const notifIds = row.attachDefaultNotifications
			? s.defaultNotificationIds()
			: [];

		// Create missing monitors.
		for (const d of desired) {
			if (managed[d.host] && existingIds.has(managed[d.host] as number))
				continue;
			// A user-made monitor already covers this URL — adopt by skipping (no dupe,
			// and we won't delete it since it's not recorded as managed).
			if (existingUrls.has(d.url.replace(/\/$/, ""))) continue;
			try {
				const id = await s.addMonitor(d.host, d.url, notifIds);
				managed[d.host] = id;
				added++;
				// Tag it "nomploy" (best-effort — never fail the create over a tag).
				try {
					const tagId = await s.ensureTag("nomploy", "#10b981");
					await s.attachTag(id, tagId);
				} catch (e) {
					console.error(`uptime-kuma: tag monitor ${d.host} failed:`, e);
				}
			} catch (e) {
				console.error(`uptime-kuma: add monitor ${d.host} failed:`, e);
			}
		}

		// Remove monitors we created for hosts that are gone.
		for (const [host, id] of Object.entries(managed)) {
			if (desiredByHost.has(host)) continue;
			if (existingIds.has(id)) {
				try {
					await s.deleteMonitor(id);
					removed++;
				} catch (e) {
					console.error(`uptime-kuma: delete monitor ${host} failed:`, e);
				}
			}
			delete managed[host];
		}

		return { total: s.monitors.length - removed + added };
	});

	await db
		.update(uptimeKuma)
		.set({
			managedMonitors: managed,
			lastSyncAt: new Date(),
			lastSyncStatus: `Synced — ${added} added, ${removed} removed`,
		})
		.where(eq(uptimeKuma.organizationId, organizationId));

	return { added, removed, total: result.total };
};

/** Fire-and-forget sync nudge for the domain-change hot path (never throws). */
export const nudgeUptimeKuma = (organizationId: string): void => {
	void syncUptimeKumaMonitors(organizationId).catch((e) =>
		console.error("uptime-kuma: nudge sync failed:", e),
	);
};

// ---------------------------------------------------------------------------
// Status (for the UI)
// ---------------------------------------------------------------------------

export type UptimeKumaMonitorStatus = {
	id: number;
	name: string;
	url: string | null;
	status: number | null; // 1=up 0=down 2=pending 3=maint, null=unknown
	managed: boolean;
};

/** Live monitor list + up/down status, for the settings page. */
export const getUptimeKumaStatus = async (
	organizationId: string,
): Promise<{
	connected: boolean;
	monitors: UptimeKumaMonitorStatus[];
	error?: string;
}> => {
	const row = await getRow(organizationId);
	if (!row) return { connected: false, monitors: [] };
	const managedIds = new Set(Object.values(row.managedMonitors ?? {}));
	try {
		const monitors = await withUptimeKuma(connOf(row), async (s) => {
			// Let heartbeats settle so up/down is populated for the snapshot.
			await new Promise((r) => setTimeout(r, 1200));
			return s.monitors.map((m) => ({
				id: m.id,
				name: m.name,
				url: m.url,
				status: s.statusOf(m.id),
				managed: managedIds.has(m.id),
			}));
		});
		return { connected: true, monitors };
	} catch (e) {
		return {
			connected: false,
			monitors: [],
			error: e instanceof Error ? e.message : String(e),
		};
	}
};

// ---------------------------------------------------------------------------
// Background reconcile loop (self-healing, decoupled from the DNS hot path)
// ---------------------------------------------------------------------------

export const startUptimeKumaSyncLoop = (
	intervalMinutes = 2,
): NodeJS.Timeout => {
	const tick = async () => {
		try {
			const rows = await db.query.uptimeKuma.findMany({
				where: eq(uptimeKuma.enabled, true),
				columns: { organizationId: true },
			});
			for (const { organizationId } of rows) {
				try {
					await syncUptimeKumaMonitors(organizationId);
				} catch (e) {
					console.error(
						`uptime-kuma: sync failed for org ${organizationId}:`,
						e,
					);
				}
			}
		} catch (e) {
			console.error("uptime-kuma: loop error:", e);
		}
	};
	void tick();
	return setInterval(tick, intervalMinutes * 60 * 1000);
};
