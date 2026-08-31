/**
 * nomploy — free (Apache-2.0) replacement for the former enterprise SSO helpers.
 *
 * SSO (OIDC / SAML) was a paid enterprise feature and is not shipped in nomploy.
 * `getSSOProviders` therefore reports no configured providers. The remaining
 * functions are small, generic utilities kept so the auth layer keeps compiling.
 */
import { db } from "@nomploy/server/db";
import { organization } from "@nomploy/server/db/schema";
import { eq } from "drizzle-orm";

/** SSO is not available in nomploy — there are never any configured providers. */
export const getSSOProviders = async () => {
	return [] as Array<{
		id: string;
		providerId: string;
		issuer: string;
		domain: string;
		oidcConfig: unknown;
		samlConfig: unknown;
	}>;
};

/** Convert an incoming request's headers into a standard `Headers` object. */
export const requestToHeaders = (req: {
	headers?: Record<string, string | string[] | undefined>;
}): Headers => {
	const headers = new Headers();
	if (req?.headers) {
		for (const [key, value] of Object.entries(req.headers)) {
			if (value !== undefined && key.toLowerCase() !== "host") {
				headers.set(key, Array.isArray(value) ? value.join(", ") : value);
			}
		}
	}
	return headers;
};

/** Trim and drop trailing slashes, e.g. "https://x.com/" -> "https://x.com". */
export const normalizeTrustedOrigin = (value: string): string => {
	return value.trim().replace(/\/+$/, "");
};

/** Look up the owner (user id) of an organization. */
export const getOrganizationOwnerId = async (organizationId: string) => {
	const org = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: { ownerId: true },
	});
	return org?.ownerId ?? null;
};
