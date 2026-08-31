/**
 * nomploy — audit logs are an enterprise feature that is not shipped.
 */
import { EnterpriseFeatureLocked } from "@/components/proprietary/enterprise-feature-gate";

export function ShowAuditLogs() {
	return (
		<EnterpriseFeatureLocked
			title="Audit Logs"
			description="Audit logging is not part of nomploy."
		/>
	);
}
