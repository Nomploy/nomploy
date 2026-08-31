/**
 * nomploy — custom RBAC roles are an enterprise feature that is not shipped.
 * Only the static roles (owner / admin / member) are available.
 */
import { EnterpriseFeatureLocked } from "@/components/proprietary/enterprise-feature-gate";

export const ManageCustomRoles = () => {
	return (
		<EnterpriseFeatureLocked
			title="Custom Roles"
			description="Custom RBAC roles are not part of nomploy. The owner, admin and member roles are available."
		/>
	);
};
