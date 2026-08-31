/**
 * nomploy — the branding config is stored in web server settings and can be set
 * via the `whitelabeling` tRPC router, but the full enterprise editor UI is not
 * shipped. This placeholder keeps the settings page functional.
 */
import { EnterpriseFeatureLocked } from "@/components/proprietary/enterprise-feature-gate";

export function WhitelabelingSettings() {
	return (
		<EnterpriseFeatureLocked
			title="Branding"
			description="The full branding editor is not part of nomploy. Branding can be configured through the whitelabeling API."
		/>
	);
}
