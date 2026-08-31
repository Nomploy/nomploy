/**
 * nomploy — there is no commercial licensing, so there is nothing to manage here.
 */
import { EnterpriseFeatureLocked } from "@/components/proprietary/enterprise-feature-gate";

export function LicenseKeySettings() {
	return (
		<EnterpriseFeatureLocked
			title="License"
			description="nomploy is free and open source (Apache-2.0). There is no license key to configure."
		/>
	);
}
