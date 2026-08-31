/**
 * nomploy — SSO (OIDC / SAML) is an enterprise feature that is not shipped.
 */
import { EnterpriseFeatureLocked } from "@/components/proprietary/enterprise-feature-gate";

export const SSOSettings = () => {
	return (
		<EnterpriseFeatureLocked
			title="Single Sign-On"
			description="SSO (OIDC / SAML) is not part of nomploy. Use email / password authentication instead."
		/>
	);
};
