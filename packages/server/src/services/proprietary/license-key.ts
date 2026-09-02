/**
 * nomploy — free (Apache-2.0) replacement for the former enterprise license gate.
 *
 * The upstream project gated a set of enterprise features (custom RBAC roles,
 * per-member server / git-provider scoping, SSO, audit logs, white-labeling)
 * behind a commercial license. nomploy ships without those paid features, so
 * this always reports "no enterprise license".
 *
 * Effect across the codebase:
 *   - all organization members can see every server / git provider
 *     (no per-member access scoping)
 *   - only the static roles (owner / admin / member) exist
 *   - enterprise-only endpoints return the free-tier behaviour
 */
export const hasValidLicense = async (_organizationId: string) => {
	return false;
};
