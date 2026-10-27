import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { dnsProvider } from "../db/schema";
import { cfListZones } from "../setup/loadbalancer-dns";
import { route53ListZones } from "../setup/route53-dns";

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
	// Any enabled DNS provider (cloudflare, route53, …) issues via DNS-01 — the only
	// challenge that works behind the HA pool. reconfigureTraefikForDns sets up the
	// `letsencrypt-dns` resolver for whichever provider is enabled.
	return active ? "letsencrypt-dns" : "letsencrypt";
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

/**
 * Map each host to the `letsencrypt-<provider>` resolver whose enabled DNS provider
 * owns its zone, so Cloudflare + Route 53 (etc.) domains can get DNS-01 certs side
 * by side. Fetches each enabled provider's zone list once, then matches locally
 * (longest-suffix wins). Hosts not matched to any provider's zone — or when the only
 * providers are ones we can't enumerate — are left out (the caller falls back to the
 * default `letsencrypt-dns`). Empty map when no DNS provider is enabled.
 */
export const resolveCertResolversForHosts = async (
	organizationId: string,
	hosts: string[],
): Promise<Map<string, string>> => {
	const map = new Map<string, string>();
	if (hosts.length === 0) return map;
	const providers = await db.query.dnsProvider.findMany({
		where: and(
			eq(dnsProvider.organizationId, organizationId),
			eq(dnsProvider.enabled, true),
		),
		columns: { provider: true, token: true },
	});
	if (providers.length === 0) return map;

	// Pre-fetch zones per provider (only cloudflare/route53 can be enumerated).
	const provZones: { provider: string; zones: string[] }[] = [];
	for (const p of providers) {
		if (!p.token) continue;
		try {
			if (p.provider === "cloudflare") {
				provZones.push({
					provider: "cloudflare",
					zones: (await cfListZones(p.token)).map((z) => z.name),
				});
			} else if (p.provider === "route53") {
				provZones.push({
					provider: "route53",
					zones: (await route53ListZones(p.token)).map((z) => z.name),
				});
			}
		} catch {
			// skip a provider whose zones can't be listed right now
		}
	}

	for (const host of hosts) {
		let best: { provider: string; len: number } | null = null;
		for (const pz of provZones) {
			for (const zn of pz.zones) {
				if (host === zn || host.endsWith(`.${zn}`)) {
					if (!best || zn.length > best.len)
						best = { provider: pz.provider, len: zn.length };
				}
			}
		}
		if (best) map.set(host, `letsencrypt-${best.provider}`);
	}
	return map;
};

/**
 * Per-domain version of {@link applyDefaultCertResolver}: stamps each Let's Encrypt
 * domain with the resolver of the provider that owns its zone, falling back to the
 * default (`letsencrypt-dns`, or `letsencrypt`/HTTP-01 when no provider is enabled).
 * Use this wherever a job can carry domains across different DNS providers.
 */
export const applyPerHostCertResolver = async <
	T extends {
		host: string;
		https?: boolean | null;
		certificateType?: string | null;
		customCertResolver?: string | null;
	},
>(
	organizationId: string,
	domains: T[],
): Promise<T[]> => {
	const targets = domains.filter(
		(d) =>
			d.https && d.certificateType === "letsencrypt" && !d.customCertResolver,
	);
	if (targets.length === 0) return domains;
	const fallback = await getDefaultCertResolver();
	if (fallback === "letsencrypt") return domains; // no DNS provider → HTTP-01
	const byHost = await resolveCertResolversForHosts(
		organizationId,
		targets.map((d) => d.host),
	);
	return domains.map((d) =>
		d.https && d.certificateType === "letsencrypt" && !d.customCertResolver
			? { ...d, customCertResolver: byHost.get(d.host) ?? fallback }
			: d,
	);
};
