/**
 * nomploy — original (Apache/AGPL) audit-log implementation.
 *
 * Records who did what, when, to which resource. Written from the `audit()` tRPC
 * helper across the routers and read back by the Audit Logs settings page. This
 * is nomploy's own implementation against the existing `auditLog` table (it does
 * NOT reuse any upstream enterprise/DSAL code).
 */

import { db } from "@nomploy/server/db";
import {
	type AuditAction,
	type AuditResourceType,
	auditLog,
} from "@nomploy/server/db/schema";
import { and, count, desc, eq, gte, ilike, lte } from "drizzle-orm";

export type { AuditAction, AuditResourceType };

export interface CreateAuditLogInput {
	organizationId: string;
	userId: string;
	userEmail: string;
	userRole: string;
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Record one audit entry. Never throws: an audit write must never break the
 * action it is logging, so failures are swallowed (and logged to the console).
 */
export const createAuditLog = async (input: CreateAuditLogInput) => {
	try {
		await db.insert(auditLog).values({
			organizationId: input.organizationId,
			userId: input.userId,
			userEmail: input.userEmail,
			userRole: input.userRole,
			action: input.action,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			resourceName: input.resourceName,
			metadata: input.metadata ? JSON.stringify(input.metadata) : null,
		});
	} catch (error) {
		console.error("audit-log write failed:", error);
	}
};

export interface GetAuditLogsInput {
	organizationId: string;
	userId?: string;
	userEmail?: string;
	resourceName?: string;
	action?: AuditAction;
	resourceType?: AuditResourceType;
	from?: Date;
	to?: Date;
	limit?: number;
	offset?: number;
}

export interface AuditLogRow {
	id: string;
	organizationId: string | null;
	userId: string | null;
	userEmail: string;
	userRole: string;
	action: string;
	resourceType: string;
	resourceId: string | null;
	resourceName: string | null;
	metadata: Record<string, unknown> | null;
	createdAt: Date;
}

/**
 * Read audit entries for an org, newest first, with optional filters and paging.
 * Returns the page of rows plus the total matching count (for pagination).
 */
export const getAuditLogs = async (input: GetAuditLogsInput) => {
	const limit = Math.min(input.limit ?? 50, 200);
	const offset = input.offset ?? 0;

	const conditions = [eq(auditLog.organizationId, input.organizationId)];
	if (input.userId) conditions.push(eq(auditLog.userId, input.userId));
	if (input.userEmail)
		conditions.push(ilike(auditLog.userEmail, `%${input.userEmail}%`));
	if (input.resourceName)
		conditions.push(ilike(auditLog.resourceName, `%${input.resourceName}%`));
	if (input.action) conditions.push(eq(auditLog.action, input.action));
	if (input.resourceType)
		conditions.push(eq(auditLog.resourceType, input.resourceType));
	if (input.from) conditions.push(gte(auditLog.createdAt, input.from));
	if (input.to) conditions.push(lte(auditLog.createdAt, input.to));
	const where = and(...conditions);

	const [rows, totalRes] = await Promise.all([
		db
			.select()
			.from(auditLog)
			.where(where)
			.orderBy(desc(auditLog.createdAt))
			.limit(limit)
			.offset(offset),
		db.select({ value: count() }).from(auditLog).where(where),
	]);

	const logs: AuditLogRow[] = rows.map((r) => ({
		...r,
		metadata: r.metadata ? safeParse(r.metadata) : null,
	}));
	return { logs, total: totalRes[0]?.value ?? 0 };
};

const safeParse = (s: string): Record<string, unknown> | null => {
	try {
		return JSON.parse(s) as Record<string, unknown>;
	} catch {
		return null;
	}
};
