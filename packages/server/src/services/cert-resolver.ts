import { eq } from "drizzle-orm";
import { db } from "../db";
import { dnsProvider } from "../db/schema";

/**
 * The ACME cert resolver a "Let's Encrypt" domain should use by default.
 *
 * HTTP-01 (the default `letsencrypt` resolver) cannot work behind the HA
 * "LoadBalancer" pool: the domain's DNS round-robins across every pool node, so
 * Let's Encrypt's challenge request lands on a node that doesn't hold the token
 * → 404 (see setup/traefik-ha.ts and setup/loadbalancer-dns.ts). When an enabled
 * DNS provider exists we therefore switch the default to its DNS-01 resolver
 * (`letsencrypt-dns`, added to traefik.yml by reconfigureTraefikForDns), which
 * validates via a TXT record and is node-independent. Falls back to `letsencrypt`
 * when no provider is enabled, so single-node installs keep issuing via HTTP-01.
 *
 * Caveat: DNS-01 only works for zones in the provider's account. Enabling a
 * provider is an explicit admin action (Settings → DNS Providers), and for the
 * HA LoadBalancer it is the only challenge that works — so this is the intended
 * tradeoff. Extensible: map provider → resolver name here as more are added.
 */
export const getDefaultCertResolver = async (): Promise<string> => {
	const active = await db.query.dnsProvider.findFirst({
		where: eq(dnsProvider.enabled, true),
		columns: { provider: true },
	});
	return active?.provider === "cloudflare" ? "letsencrypt-dns" : "letsencrypt";
};

/**
 * Stamp the given default cert resolver onto "Let's Encrypt" domains that don't
 * already pin a custom one, so the Consul/Traefik router tags reference it (see
 * generateConsulTags). A no-op for the `letsencrypt` default, for non-Let's
 * Encrypt certificate types, and for domains that already set customCertResolver.
 */
export const applyDefaultCertResolver = <
	T extends {
		https?: boolean | null;
		certificateType?: string | null;
		customCertResolver?: string | null;
	},
>(
	domains: T[],
	resolver: string,
): T[] =>
	resolver === "letsencrypt"
		? domains
		: domains.map((d) =>
				d.https && d.certificateType === "letsencrypt" && !d.customCertResolver
					? { ...d, customCertResolver: resolver }
					: d,
			);
