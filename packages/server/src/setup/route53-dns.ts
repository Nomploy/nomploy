import {
	ChangeResourceRecordSetsCommand,
	ListHostedZonesCommand,
	ListResourceRecordSetsCommand,
	Route53Client,
} from "@aws-sdk/client-route-53";

/**
 * AWS Route 53 side of the LoadBalancer DNS auto-point (the Cloudflare side lives in
 * setup/loadbalancer-dns.ts). Route 53 can't CNAME/ALIAS an apex to an external name
 * like `lb-<id>.<zone>`, so:
 *   - apex host  → **A records = the healthy pool IPs** (kept in sync by the reconcile
 *     loop, so failover works), and
 *   - subdomain  → CNAME → the LB hostname (which itself tracks the pool).
 *
 * Credentials are stored in the dnsProvider `token` as
 * `accessKeyId:secretAccessKey[:region]` (region optional → us-east-1), same format
 * the DNS-01 cert path parses (see services/settings.ts dnsProviderEnvEntries).
 */

export type R53Zone = { id: string; name: string };

type R53Creds = {
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
};

export const parseRoute53Creds = (token: string): R53Creds | null => {
	const [accessKeyId, secretAccessKey, region] = (token ?? "").split(":");
	if (!accessKeyId || !secretAccessKey) return null;
	return { accessKeyId, secretAccessKey, region: region || "us-east-1" };
};

const clientFor = (c: R53Creds): Route53Client =>
	new Route53Client({
		region: c.region,
		credentials: {
			accessKeyId: c.accessKeyId,
			secretAccessKey: c.secretAccessKey,
		},
	});

const stripDot = (s: string): string => s.replace(/\.$/, "");

/** All hosted zones the creds can see (public zones; follows pagination). */
export const route53ListZones = async (token: string): Promise<R53Zone[]> => {
	const creds = parseRoute53Creds(token);
	if (!creds) return [];
	const client = clientFor(creds);
	const out: R53Zone[] = [];
	let marker: string | undefined;
	do {
		const res = await client.send(
			new ListHostedZonesCommand({ Marker: marker }),
		);
		for (const z of res.HostedZones ?? []) {
			// Skip private zones — they can't serve public ACME/traffic.
			if (z.Config?.PrivateZone) continue;
			if (z.Id && z.Name) out.push({ id: z.Id, name: stripDot(z.Name) });
		}
		marker = res.IsTruncated ? res.NextMarker : undefined;
	} while (marker);
	return out;
};

/** The most specific hosted zone that governs `host`, or null. */
export const route53ZoneForHost = async (
	token: string,
	host: string,
): Promise<R53Zone | null> => {
	let best: R53Zone | null = null;
	for (const z of await route53ListZones(token)) {
		if (host === z.name || host.endsWith(`.${z.name}`)) {
			if (!best || z.name.length > best.name.length) best = z;
		}
	}
	return best;
};

const applyChange = async (
	creds: R53Creds,
	zoneId: string,
	action: "UPSERT" | "DELETE",
	// biome-ignore lint/suspicious/noExplicitAny: Route53 rrset shape
	resourceRecordSet: any,
): Promise<void> => {
	await clientFor(creds).send(
		new ChangeResourceRecordSetsCommand({
			HostedZoneId: zoneId,
			ChangeBatch: {
				Changes: [{ Action: action, ResourceRecordSet: resourceRecordSet }],
			},
		}),
	);
};

/**
 * Point `host` at the LB in Route 53. Apex → A records = `poolIps`; subdomain →
 * CNAME → `lbHostname`. Idempotent (UPSERT). No-op if no creds / no governing zone /
 * (apex with) no healthy pool IPs.
 */
export const route53PointDomain = async (
	token: string,
	host: string,
	lbHostname: string,
	poolIps: string[],
	zone?: R53Zone | null,
): Promise<void> => {
	const creds = parseRoute53Creds(token);
	if (!creds) return;
	const z = zone ?? (await route53ZoneForHost(token, host));
	if (!z) return;
	if (host === z.name) {
		// Apex: A records straight to the pool (no external CNAME possible here).
		if (poolIps.length === 0) return;
		await applyChange(creds, z.id, "UPSERT", {
			Name: host,
			Type: "A",
			TTL: 60,
			ResourceRecords: poolIps.map((ip) => ({ Value: ip })),
		});
	} else {
		await applyChange(creds, z.id, "UPSERT", {
			Name: host,
			Type: "CNAME",
			TTL: 60,
			ResourceRecords: [{ Value: lbHostname }],
		});
	}
};

/** Remove the A/CNAME record nomploy created for `host` (DELETE needs the exact set). */
export const route53UnpointDomain = async (
	token: string,
	host: string,
): Promise<void> => {
	const creds = parseRoute53Creds(token);
	if (!creds) return;
	const z = await route53ZoneForHost(token, host);
	if (!z) return;
	const res = await clientFor(creds).send(
		new ListResourceRecordSetsCommand({
			HostedZoneId: z.id,
			StartRecordName: `${host}.`,
		}),
	);
	for (const rr of res.ResourceRecordSets ?? []) {
		if (stripDot(rr.Name ?? "") !== host) continue;
		if (rr.Type === "A" || rr.Type === "CNAME") {
			await applyChange(creds, z.id, "DELETE", rr);
		}
	}
};

/** Read-only: is `host` already pointed in Route 53, and to what. */
export const route53PointStatus = async (
	token: string,
	host: string,
	poolIps: string[],
	lbHostname: string,
): Promise<{ pointed: boolean; detail: string } | null> => {
	const creds = parseRoute53Creds(token);
	if (!creds) return null;
	const z = await route53ZoneForHost(token, host);
	if (!z) return null;
	const res = await clientFor(creds).send(
		new ListResourceRecordSetsCommand({
			HostedZoneId: z.id,
			StartRecordName: `${host}.`,
		}),
	);
	const recs = (res.ResourceRecordSets ?? []).filter(
		(rr) => stripDot(rr.Name ?? "") === host,
	);
	const isApex = host === z.name;
	if (isApex) {
		const a = recs.find((rr) => rr.Type === "A");
		const vals = (a?.ResourceRecords ?? []).map((r) => r.Value ?? "");
		const pointed = vals.length > 0 && vals.every((v) => poolIps.includes(v));
		return { pointed, detail: vals.length ? vals.join(", ") : "no A record" };
	}
	const cname = recs.find((rr) => rr.Type === "CNAME");
	const target = stripDot(cname?.ResourceRecords?.[0]?.Value ?? "");
	return {
		pointed: target === stripDot(lbHostname),
		detail: target || "no CNAME",
	};
};
