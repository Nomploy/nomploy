/**
 * nomploy — free (Apache-2.0) replacement for the former enterprise audit log.
 *
 * Audit logging was a paid enterprise feature. nomploy keeps the same public
 * API so the auth layer and routers keep compiling, but writing is a no-op and
 * reads return an empty result set. The `auditLog` table still exists in the
 * schema; nothing here depends on it.
 */
import type { AuditAction, AuditResourceType } from "@nomploy/server/db/schema";

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

/** No-op in nomploy — audit logging is an enterprise feature that is not shipped. */
export const createAuditLog = async (_input: CreateAuditLogInput) => {
	return;
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

/** Always empty in nomploy — audit logging is not shipped. */
export const getAuditLogs = async (_input: GetAuditLogsInput) => {
	return { logs: [] as unknown[], total: 0 };
};
