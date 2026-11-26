import { db } from "@nomploy/server/db";
import { destinations } from "@nomploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, ne } from "drizzle-orm";
import { scheduleBackup } from "../utils/backups/utils";
import { createBackup, findBackupById } from "./backup";
import { findLibsqlById } from "./libsql";
import { findMariadbById } from "./mariadb";
import { findMongoById } from "./mongo";
import { findMySqlById } from "./mysql";
import { findPostgresById } from "./postgres";

/**
 * One-click / automatic database backups.
 *
 * Everything a backup needs is already known: the S3 destination (with creds)
 * lives in `destination`, the database name in the DB row. These helpers build a
 * sane default backup (daily, staggered, keep 7) on the org's default destination
 * so the user doesn't have to fill the form.
 */

export const PROTECTABLE_DATABASE_TYPES = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"libsql",
] as const;
export type ProtectableDatabaseType =
	(typeof PROTECTABLE_DATABASE_TYPES)[number];

export const DEFAULT_BACKUP_KEEP_LATEST = 7;

/**
 * Daily between 02:00 and 04:59, minute/hour derived from the app name so a
 * cluster's databases don't all dump (and hammer S3/disk) at the same instant.
 * Deterministic: protecting the same DB again yields the same slot.
 */
export const defaultBackupSchedule = (appName: string) => {
	let h = 0;
	for (const ch of appName) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	const minute = h % 60;
	const hour = 2 + (Math.floor(h / 60) % 3);
	return `${minute} ${hour} * * *`;
};

/**
 * The org's default backup destination: the one flagged `isDefaultBackup`, or
 * — when the org has exactly one destination — that one. Null otherwise.
 */
export const findDefaultBackupDestination = async (organizationId: string) => {
	const all = await db.query.destinations.findMany({
		where: eq(destinations.organizationId, organizationId),
	});
	return (
		all.find((d) => d.isDefaultBackup) ??
		(all.length === 1 ? all[0] : null) ??
		null
	);
};

/** Make `destinationId` the org's only default backup destination. */
export const setDefaultBackupDestination = async (
	organizationId: string,
	destinationId: string,
	settings: { isDefaultBackup: boolean; autoProtectNewDatabases: boolean },
) => {
	return db.transaction(async (tx) => {
		if (settings.isDefaultBackup) {
			await tx
				.update(destinations)
				.set({ isDefaultBackup: false, autoProtectNewDatabases: false })
				.where(
					and(
						eq(destinations.organizationId, organizationId),
						ne(destinations.destinationId, destinationId),
					),
				);
		}
		const [row] = await tx
			.update(destinations)
			.set({
				isDefaultBackup: settings.isDefaultBackup,
				// auto-protect only makes sense on the default destination
				autoProtectNewDatabases:
					settings.isDefaultBackup && settings.autoProtectNewDatabases,
			})
			.where(
				and(
					eq(destinations.organizationId, organizationId),
					eq(destinations.destinationId, destinationId),
				),
			)
			.returning();
		if (!row) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Destination not found",
			});
		}
		return row;
	});
};

const loadDatabase = async (type: ProtectableDatabaseType, id: string) => {
	switch (type) {
		case "postgres": {
			const d = await findPostgresById(id);
			return { row: d, databaseName: d.databaseName as string | null };
		}
		case "mysql": {
			const d = await findMySqlById(id);
			return { row: d, databaseName: d.databaseName as string | null };
		}
		case "mariadb": {
			const d = await findMariadbById(id);
			return { row: d, databaseName: d.databaseName as string | null };
		}
		case "mongo": {
			// Mongo rows carry no database name; mongodump needs one (-d), so a
			// default can't be derived — the user picks it in the form.
			const d = await findMongoById(id);
			return { row: d, databaseName: null };
		}
		case "libsql": {
			const d = await findLibsqlById(id);
			return { row: d, databaseName: "iku.db" };
		}
	}
};

const idField = (type: ProtectableDatabaseType, id: string) => {
	switch (type) {
		case "postgres":
			return { postgresId: id };
		case "mysql":
			return { mysqlId: id };
		case "mariadb":
			return { mariadbId: id };
		case "mongo":
			return { mongoId: id };
		case "libsql":
			return { libsqlId: id };
	}
};

/**
 * Suggested form values for a new backup of this DB (prefill for the
 * "Create Backup" dialog). Every field may be empty when unknown.
 */
export const suggestDefaultBackup = async (opts: {
	databaseType: ProtectableDatabaseType;
	serviceId: string;
	organizationId: string;
}) => {
	const { row, databaseName } = await loadDatabase(
		opts.databaseType,
		opts.serviceId,
	);
	if (row.environment.project.organizationId !== opts.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this database",
		});
	}
	const destination = await findDefaultBackupDestination(opts.organizationId);
	return {
		destinationId: destination?.destinationId ?? "",
		database: databaseName ?? "",
		schedule: defaultBackupSchedule(row.appName),
		keepLatestCount: DEFAULT_BACKUP_KEEP_LATEST,
	};
};

export type DefaultBackupResult =
	| { status: "created"; backupId: string }
	| { status: "exists" }
	| { status: "unsupported"; reason: string };

/**
 * Create a default backup for one database on the org's default destination
 * (or `destinationId`). Idempotent: a DB that already has a backup is left
 * alone. Throws if the DB isn't in `organizationId` or no destination is set.
 */
export const createDefaultDatabaseBackup = async (opts: {
	databaseType: ProtectableDatabaseType;
	serviceId: string;
	organizationId: string;
	destinationId?: string;
}): Promise<DefaultBackupResult> => {
	const { row, databaseName } = await loadDatabase(
		opts.databaseType,
		opts.serviceId,
	);
	if (row.environment.project.organizationId !== opts.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this database",
		});
	}
	if (row.backups.length > 0) return { status: "exists" };
	if (!databaseName) {
		return {
			status: "unsupported",
			reason: `${opts.databaseType} has no known database name — set it up via Customize`,
		};
	}

	const destination = opts.destinationId
		? await db.query.destinations.findFirst({
				where: and(
					eq(destinations.destinationId, opts.destinationId),
					eq(destinations.organizationId, opts.organizationId),
				),
			})
		: await findDefaultBackupDestination(opts.organizationId);
	if (!destination) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"No default backup destination — add an S3 destination or mark one as default in Settings → S3 Destinations",
		});
	}

	const created = await createBackup({
		...idField(opts.databaseType, opts.serviceId),
		destinationId: destination.destinationId,
		database: databaseName,
		databaseType: opts.databaseType,
		backupType: "database",
		schedule: defaultBackupSchedule(row.appName),
		prefix: "/",
		enabled: true,
		keepLatestCount: DEFAULT_BACKUP_KEEP_LATEST,
	} as Parameters<typeof createBackup>[0]);

	const full = await findBackupById(created.backupId);
	if (full.enabled) scheduleBackup(full);
	return { status: "created", backupId: created.backupId };
};

/**
 * Auto-protect hook for DB create: if the org's default destination has
 * `autoProtectNewDatabases`, give the new DB a default backup. Never throws —
 * a backup hiccup must not fail database creation.
 */
export const autoProtectNewDatabase = async (opts: {
	databaseType: ProtectableDatabaseType;
	serviceId: string;
	organizationId: string;
}) => {
	try {
		const destination = await findDefaultBackupDestination(opts.organizationId);
		if (!destination?.autoProtectNewDatabases) return;
		await createDefaultDatabaseBackup({
			...opts,
			destinationId: destination.destinationId,
		});
	} catch (error) {
		console.error("autoProtectNewDatabase failed", error);
	}
};
