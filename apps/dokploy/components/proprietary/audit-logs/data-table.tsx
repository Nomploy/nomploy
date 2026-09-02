/**
 * nomploy — audit logs are not shipped; these are inert placeholders kept so any
 * lingering imports keep type-checking.
 */
export interface AuditLogFilters {
	userId?: string;
	userEmail?: string;
	resourceName?: string;
	action?: string;
	resourceType?: string;
	from?: Date;
	to?: Date;
}

export function DataTable(_props: Record<string, unknown>) {
	return null;
}
