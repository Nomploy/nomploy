import { io, type Socket } from "socket.io-client";

/**
 * Minimal client for Uptime Kuma's Socket.IO "internal API" (louislam/uptime-kuma
 * has no REST API for monitor CRUD). We open a short-lived connection, log in,
 * read the pushed monitor list, do the work, and disconnect — the sync runs at
 * domain-change frequency, so holding a socket open buys nothing and a fresh
 * login is more robust to the server restarting.
 *
 * The internal API is explicitly unsupported and may change between Uptime Kuma
 * versions — pin the Uptime Kuma version alongside this client.
 */

export type UptimeKumaConn = {
	baseUrl: string;
	username: string;
	password: string;
};

export type KumaMonitor = {
	id: number;
	name: string;
	url: string | null;
	type: string;
	active: boolean;
};

const CONNECT_TIMEOUT_MS = 12_000;
const OP_TIMEOUT_MS = 12_000;

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
	Promise.race([
		p,
		new Promise<T>((_, reject) =>
			setTimeout(
				() => reject(new Error(`Uptime Kuma: ${label} timed out`)),
				ms,
			),
		),
	]);

type Ack = { ok?: boolean; msg?: string; monitorID?: number; token?: string };

// Emit an event and await its ack callback (Uptime Kuma replies via the socket.io
// ack, not a separate event).
const emitAck = (
	socket: Socket,
	event: string,
	...args: unknown[]
): Promise<Ack> =>
	withTimeout(
		new Promise<Ack>((resolve, reject) => {
			socket.emit(event, ...args, (res: Ack) => {
				if (res && res.ok === false) {
					reject(new Error(res.msg || `Uptime Kuma: ${event} failed`));
				} else {
					resolve(res ?? {});
				}
			});
		}),
		OP_TIMEOUT_MS,
		event,
	);

/** A live, logged-in session plus the current monitor list it pushed on login. */
export type KumaSession = {
	socket: Socket;
	monitors: KumaMonitor[];
	/** Latest heartbeat status per monitor id: 1=up, 0=down, 2=pending, 3=maint. */
	statusOf: (id: number) => number | null;
	/** Ids of the notifications marked "Default" in Uptime Kuma. */
	defaultNotificationIds: () => number[];
	addMonitor: (
		name: string,
		url: string,
		notificationIds?: number[],
	) => Promise<number>;
	deleteMonitor: (id: number) => Promise<void>;
	/** Find or create a tag by name; returns its id (cached per session). */
	ensureTag: (name: string, color: string) => Promise<number>;
	/** Attach a tag to a monitor (no-op-safe if already attached). */
	attachTag: (monitorId: number, tagId: number) => Promise<void>;
};

const monitorListFromPush = (raw: unknown): KumaMonitor[] => {
	// Uptime Kuma pushes `monitorList` as an object keyed by id.
	const obj = (raw ?? {}) as Record<string, Record<string, unknown>>;
	return Object.values(obj).map((m) => ({
		id: Number(m.id),
		name: String(m.name ?? ""),
		url: typeof m.url === "string" ? m.url : null,
		type: String(m.type ?? ""),
		active: m.active !== false && m.active !== 0,
	}));
};

/**
 * Open a connection, log in, and wait for the pushed `monitorList`. Runs `fn`
 * with the session, then always disconnects. Throws on connection / auth / 2FA
 * failure with a user-readable message.
 */
export const withUptimeKuma = async <T>(
	conn: UptimeKumaConn,
	fn: (session: KumaSession) => Promise<T>,
): Promise<T> => {
	const socket: Socket = io(conn.baseUrl.replace(/\/$/, ""), {
		transports: ["websocket"],
		reconnection: false,
		timeout: CONNECT_TIMEOUT_MS,
		forceNew: true,
	});

	// Uptime Kuma pushes the monitor list asynchronously after login; capture the
	// latest push so the session always sees current state.
	let latestMonitors: KumaMonitor[] = [];
	socket.on("monitorList", (raw: unknown) => {
		latestMonitors = monitorListFromPush(raw);
	});

	// Latest heartbeat status per monitor id (pushed after login).
	const beatStatus = new Map<number, number>();
	socket.on("heartbeatList", (monitorID: unknown, list: unknown) => {
		const arr = Array.isArray(list) ? list : [];
		const last = arr[arr.length - 1] as { status?: number } | undefined;
		if (last && typeof last.status !== "undefined")
			beatStatus.set(Number(monitorID), Number(last.status));
	});
	socket.on("heartbeat", (beat: { monitorID?: number; status?: number }) => {
		if (beat && beat.monitorID != null)
			beatStatus.set(Number(beat.monitorID), Number(beat.status));
	});

	// Notifications Uptime Kuma pushes after login — capture the "Default" ones so
	// created monitors can be wired to alert (e.g. Slack) like a UI-made monitor.
	let defaultNotifIds: number[] = [];
	socket.on("notificationList", (raw: unknown) => {
		const arr = Array.isArray(raw) ? raw : [];
		defaultNotifIds = arr
			.filter((n) => n && (n as { isDefault?: boolean }).isDefault)
			.map((n) => Number((n as { id?: number }).id))
			.filter((id) => Number.isFinite(id));
	});

	try {
		await withTimeout(
			new Promise<void>((resolve, reject) => {
				socket.once("connect", () => resolve());
				socket.once("connect_error", (err: Error) =>
					reject(new Error(`Uptime Kuma: cannot connect — ${err.message}`)),
				);
			}),
			CONNECT_TIMEOUT_MS,
			"connect",
		);

		const ack = await emitAck(socket, "login", {
			username: conn.username,
			password: conn.password,
			token: "",
		});
		if (ack.ok === false)
			throw new Error(ack.msg || "Uptime Kuma: login failed");
		// 2FA accounts answer login with { tokenRequired: true } and ok omitted.
		if ((ack as { tokenRequired?: boolean }).tokenRequired) {
			throw new Error(
				"Uptime Kuma: this account has 2FA enabled — use an account without 2FA for the integration.",
			);
		}

		// Give the server a beat to push the initial monitorList after login.
		await new Promise((r) => setTimeout(r, 400));

		let cachedTagId: number | null = null;
		const session: KumaSession = {
			socket,
			get monitors() {
				return latestMonitors;
			},
			statusOf: (id: number) => beatStatus.get(id) ?? null,
			defaultNotificationIds: () => defaultNotifIds,
			addMonitor: async (name, url, notificationIds) => {
				const res = await emitAck(
					socket,
					"add",
					buildHttpMonitor(name, url, notificationIds),
				);
				if (!res.monitorID)
					throw new Error("Uptime Kuma: add returned no monitor id");
				return res.monitorID;
			},
			deleteMonitor: async (id) => {
				await emitAck(socket, "deleteMonitor", id);
			},
			ensureTag: async (name, color) => {
				if (cachedTagId != null) return cachedTagId;
				const list = (await emitAck(socket, "getTags")) as {
					tags?: { id: number; name: string }[];
				};
				const found = (list.tags ?? []).find((t) => t.name === name);
				if (found) {
					cachedTagId = found.id;
					return found.id;
				}
				const added = (await emitAck(socket, "addTag", { name, color })) as {
					tag?: { id: number };
				};
				const id = added.tag?.id;
				if (!id) throw new Error("Uptime Kuma: addTag returned no id");
				cachedTagId = id;
				return id;
			},
			attachTag: async (monitorId, tagId) => {
				// addMonitorTag(tagId, monitorID, value) — value is a free-text label.
				await emitAck(socket, "addMonitorTag", tagId, monitorId, "");
			},
		} as KumaSession;

		return await fn(session);
	} finally {
		socket.disconnect();
	}
};

// A sensible default HTTP monitor. Uptime Kuma fills in the rest; we set the
// fields that matter for a plain website up-check.
const buildHttpMonitor = (
	name: string,
	url: string,
	notificationIds?: number[],
): Record<string, unknown> => ({
	type: "http",
	name,
	url,
	method: "GET",
	interval: 60,
	retryInterval: 60,
	resendInterval: 0,
	maxretries: 1,
	timeout: 48,
	maxredirects: 10,
	accepted_statuscodes: ["200-299", "300-399"],
	// Notify on TLS cert expiry (the "days in advance" is Uptime Kuma's own global
	// setting). nomploy also tracks cert expiry itself, so this is a second source.
	expiryNotification: true,
	ignoreTls: false,
	upsideDown: false,
	// Uptime Kuma's notificationIDList is a { [id]: true } map; wire the given
	// notifications (e.g. the "Default" ones) so the monitor actually alerts.
	notificationIDList: Object.fromEntries(
		(notificationIds ?? []).map((id) => [id, true]),
	),
	// Required by Uptime Kuma 2.x — `add` fails without it (the new conditions
	// column; harmless on 1.x). Empty = no extra pass/fail conditions.
	conditions: [],
});

/** Quick connectivity + credential check. Returns the current monitor count. */
export const testUptimeKuma = (conn: UptimeKumaConn): Promise<number> =>
	withUptimeKuma(conn, async (s) => s.monitors.length);
