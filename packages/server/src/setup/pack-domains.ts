import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { stringify } from "yaml";
import { paths } from "../constants";
import { db } from "../db";
import {
	compose as composeTable,
	type domains as domainsTable,
} from "../db/schema";
import { getDefaultCertResolver } from "../services/cert-resolver";
import { encodeBase64 } from "../utils/docker/utils";
import { execAsyncRemote } from "../utils/process/execAsync";

type Compose = typeof composeTable.$inferSelect;
type Domain = typeof domainsTable.$inferSelect;

// Nomad reads always go to the control plane (not a resource's serverId).
const nomadFetch = async <T>(path: string): Promise<T> => {
	const addr = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
	const token = process.env.NOMAD_TOKEN || "";
	const res = await fetch(`${addr.replace(/\/$/, "")}/v1${path}`, {
		headers: token ? { "X-Nomad-Token": token } : {},
	});
	if (!res.ok) throw new Error(`Nomad ${res.status} on ${path}`);
	return res.json() as Promise<T>;
};

// The port a Consul service is reachable on (its registered ServicePort) — this
// is exactly the port a domain's `<name>.service.consul:<port>` backend needs.
const consulServicePort = async (name: string): Promise<number | null> => {
	try {
		const token = process.env.CONSUL_TOKEN || "";
		const res = await fetch(
			`http://127.0.0.1:8500/v1/catalog/service/${encodeURIComponent(name)}`,
			{ headers: token ? { "X-Consul-Token": token } : {} },
		);
		if (!res.ok) return null;
		const entries = (await res.json()) as { ServicePort?: number }[];
		return entries[0]?.ServicePort ?? null;
	} catch {
		return null;
	}
};

export type PackService = { name: string; port: number | null };

/**
 * The Consul services a Nomad Pack deployment registers, with their reachable
 * ports. A pack's jobs are named after the pack, not the appName, so we find them
 * by the `pack.deployment_name == appName` meta, read each job's service stanzas,
 * then look up each service's registered port in Consul. A domain routes to one of
 * these via `<name>.service.consul:<port>`.
 */
export const loadPackServices = async (
	appName: string,
): Promise<PackService[]> => {
	let jobs: { ID: string; Meta?: Record<string, string> }[] = [];
	try {
		jobs =
			await nomadFetch<{ ID: string; Meta?: Record<string, string> }[]>(
				"/jobs?meta=true",
			);
	} catch {
		return [];
	}
	const ids = jobs
		.filter((j) => j.Meta?.["pack.deployment_name"] === appName)
		.map((j) => j.ID);

	// Resolve each service's port from the job spec: PortLabel → the group's
	// network port (prefer the host-mapped Value, else the container `To`). This is
	// deterministic and doesn't depend on the Consul name matching.
	type NomadPort = { Label?: string; Value?: number; To?: number };
	type NomadSvc = { Name?: string; PortLabel?: string };
	const jobPortByName = new Map<string, number>();
	const names = new Set<string>();
	for (const id of ids) {
		try {
			const job = await nomadFetch<{
				TaskGroups?: {
					Networks?: {
						DynamicPorts?: NomadPort[];
						ReservedPorts?: NomadPort[];
					}[];
					Services?: NomadSvc[];
					Tasks?: { Services?: NomadSvc[] }[];
				}[];
			}>(`/job/${encodeURIComponent(id)}`);
			for (const tg of job.TaskGroups ?? []) {
				const portByLabel = new Map<string, number>();
				for (const net of tg.Networks ?? []) {
					for (const p of [
						...(net.ReservedPorts ?? []),
						...(net.DynamicPorts ?? []),
					]) {
						if (p.Label) portByLabel.set(p.Label, p.Value || p.To || 0);
					}
				}
				const svcs = [
					...(tg.Services ?? []),
					...(tg.Tasks ?? []).flatMap((t) => t.Services ?? []),
				];
				for (const s of svcs) {
					if (!s.Name) continue;
					names.add(s.Name);
					const p = s.PortLabel ? portByLabel.get(s.PortLabel) : undefined;
					if (p) jobPortByName.set(s.Name, p);
				}
			}
		} catch {
			// skip unreadable job
		}
	}
	return Promise.all(
		[...names].map(async (name) => ({
			name,
			// Prefer the job-spec port; fall back to the Consul-registered port.
			port: jobPortByName.get(name) ?? (await consulServicePort(name)),
		})),
	);
};

/**
 * Live backend URLs for each of a pack's services, resolved from Nomad — the
 * running alloc's host address:port. Works whether the pack registers its
 * service in Consul or Nomad's native registry (unlike a `<svc>.service.consul`
 * backend, which needs the service in Consul). Returns serviceName →
 * ["http://addr:port", …], one per running alloc (active/active). Node addresses
 * are the wg-mesh IPs Nomad reports, reachable by Traefik on any pool node.
 */
export const resolvePackBackends = async (
	appName: string,
): Promise<Map<string, string[]>> => {
	const out = new Map<string, string[]>();
	let jobs: { ID: string; Meta?: Record<string, string> }[] = [];
	try {
		jobs =
			await nomadFetch<{ ID: string; Meta?: Record<string, string> }[]>(
				"/jobs?meta=true",
			);
	} catch {
		return out;
	}
	const ids = jobs
		.filter((j) => j.Meta?.["pack.deployment_name"] === appName)
		.map((j) => j.ID);
	if (!ids.length) return out;

	let nodes: { ID: string; Address?: string }[] = [];
	try {
		nodes = await nomadFetch<{ ID: string; Address?: string }[]>("/nodes");
	} catch {}
	const nodeAddr = new Map(nodes.map((n) => [n.ID, n.Address ?? ""]));

	type NomadPort = { Label?: string; Value?: number; To?: number };
	type NomadSvc = { Name?: string; PortLabel?: string };
	type AllocPort = { Label?: string; Value?: number; HostIP?: string };
	for (const id of ids) {
		// serviceName → portLabel, and portLabel → the spec's static/dynamic port.
		const svcPortLabel = new Map<string, string>();
		const specPortByLabel = new Map<string, number>();
		try {
			const job = await nomadFetch<{
				TaskGroups?: {
					Networks?: {
						DynamicPorts?: NomadPort[];
						ReservedPorts?: NomadPort[];
					}[];
					Services?: NomadSvc[];
					Tasks?: { Services?: NomadSvc[] }[];
				}[];
			}>(`/job/${encodeURIComponent(id)}`);
			for (const tg of job.TaskGroups ?? []) {
				for (const net of tg.Networks ?? []) {
					for (const p of [
						...(net.ReservedPorts ?? []),
						...(net.DynamicPorts ?? []),
					]) {
						if (p.Label) specPortByLabel.set(p.Label, p.Value || p.To || 0);
					}
				}
				const svcs = [
					...(tg.Services ?? []),
					...(tg.Tasks ?? []).flatMap((t) => t.Services ?? []),
				];
				for (const s of svcs) {
					if (s.Name && s.PortLabel) svcPortLabel.set(s.Name, s.PortLabel);
				}
			}
		} catch {
			continue;
		}

		let allocs: {
			NodeID?: string;
			ClientStatus?: string;
			AllocatedResources?: { Shared?: { Ports?: AllocPort[] } };
		}[] = [];
		try {
			allocs = await nomadFetch(`/job/${encodeURIComponent(id)}/allocations`);
		} catch {}
		for (const a of allocs) {
			if (a.ClientStatus !== "running") continue;
			const addr = nodeAddr.get(a.NodeID ?? "") || "";
			if (!addr) continue;
			const allocPorts = a.AllocatedResources?.Shared?.Ports ?? [];
			for (const [svc, label] of svcPortLabel) {
				// Prefer the alloc's allocated host port (bridge/dynamic networking);
				// fall back to the node address + the spec's static port (host net).
				const ap = allocPorts.find((p) => p.Label === label);
				const host = ap?.HostIP || addr;
				const port = ap?.Value || specPortByLabel.get(label) || 0;
				if (!port) continue;
				const url = `http://${host}:${port}`;
				const list = out.get(svc) ?? [];
				if (!list.includes(url)) list.push(url);
				out.set(svc, list);
			}
		}
	}
	return out;
};

// `defaultResolver` is DNS-01 (letsencrypt-dns) when a DNS provider is enabled —
// HTTP-01 can't work behind the HA pool. See services/cert-resolver.
const resolverFor = (d: Domain, defaultResolver: string): string =>
	d.certificateType === "custom" && d.customCertResolver
		? d.customCertResolver
		: defaultResolver;

/**
 * Build a Traefik file-provider dynamic config that routes each of the pack's
 * domains to its service. The backend is the running alloc's real host
 * address:port (resolved from Nomad via {@link resolvePackBackends}) — this works
 * whether the pack uses Consul or Nomad-native service registration. Falls back
 * to `<service>.service.consul:<port>` only when no live alloc is found (a
 * Consul-registered pack that's briefly between allocs). Multiple running allocs
 * become multiple backends (active/active). A reconcile loop rewrites this as
 * allocs move. HTTPS domains get a LE cert resolver + an HTTP→HTTPS redirect.
 */
export const buildPackDomainConfig = (
	compose: Pick<Compose, "appName">,
	domains: Domain[],
	backends?: Map<string, string[]>,
	defaultResolver = "letsencrypt",
): string | null => {
	const routers: Record<string, unknown> = {};
	const services: Record<string, unknown> = {};
	let any = false;

	for (const d of domains) {
		if (!d.serviceName || !d.host) continue;
		any = true;
		const base = `${compose.appName}-${d.domainId}`;
		const port = d.port ?? 80;
		const rule =
			d.path && d.path !== "/"
				? `Host(\`${d.host}\`) && PathPrefix(\`${d.path}\`)`
				: `Host(\`${d.host}\`)`;
		const https = d.certificateType && d.certificateType !== "none";

		const live = backends?.get(d.serviceName) ?? [];
		const servers = live.length
			? live.map((url) => ({ url }))
			: [{ url: `http://${d.serviceName}.service.consul:${port}` }];
		services[base] = {
			loadBalancer: {
				servers,
				passHostHeader: true,
			},
		};

		if (https) {
			routers[`${base}-web`] = {
				rule,
				entryPoints: ["web"],
				service: base,
				middlewares: ["redirect-to-https"],
			};
			routers[`${base}-secure`] = {
				rule,
				entryPoints: ["websecure"],
				service: base,
				tls: { certResolver: resolverFor(d, defaultResolver) },
			};
		} else {
			routers[base] = { rule, entryPoints: ["web"], service: base };
		}
	}

	if (!any) return null;
	return stringify({ http: { routers, services } });
};

// ── Consul KV publish (so the HA pool serves pack domains too) ───────────────
// The pool's Traefik reads dynamic config from Consul KV (rootKey "traefik"),
// NOT the hub's file-provider dir — so a hub-only file config 404s on pool nodes.
// Mirror the pack routes into KV as a Traefik dynamic-config subtree; the pool's
// consul provider serves them cluster-wide. (The hub keeps using the file.)
const CONSUL_KV = "http://127.0.0.1:8500/v1/kv";
const consulKvHeaders = (): Record<string, string> => {
	const t = process.env.CONSUL_TOKEN || "";
	return t ? { "X-Consul-Token": t } : {};
};
const kvPut = async (key: string, value: string): Promise<void> => {
	await fetch(`${CONSUL_KV}/${key}`, {
		method: "PUT",
		headers: consulKvHeaders(),
		body: value,
	});
};
const kvDeleteTree = async (prefix: string): Promise<void> => {
	await fetch(`${CONSUL_KV}/${prefix}?recurse=true`, {
		method: "DELETE",
		headers: consulKvHeaders(),
	});
};

/**
 * Publish (or clear) a pack's domain routers/services into Consul KV so the HA
 * pool's Traefik serves them. Keys use Traefik's KV layout (lowercase). Cleans
 * this app's previous routes first so removed domains don't linger. The
 * redirect-to-https middleware is referenced from the pool's file provider
 * (`@file`), where the Traefik-HA job renders it.
 */
const syncPackDomainsToConsulKV = async (
	appName: string,
	domains: Domain[],
	backends: Map<string, string[]> | undefined,
	defaultResolver: string,
): Promise<void> => {
	await kvDeleteTree(`traefik/http/routers/${appName}-`);
	await kvDeleteTree(`traefik/http/services/${appName}-`);
	for (const d of domains) {
		if (!d.serviceName || !d.host) continue;
		const base = `${appName}-${d.domainId}`;
		const port = d.port ?? 80;
		const rule =
			d.path && d.path !== "/"
				? `Host(\`${d.host}\`) && PathPrefix(\`${d.path}\`)`
				: `Host(\`${d.host}\`)`;
		const https = d.certificateType && d.certificateType !== "none";
		const live = backends?.get(d.serviceName) ?? [];
		const servers = live.length
			? live
			: [`http://${d.serviceName}.service.consul:${port}`];
		for (let i = 0; i < servers.length; i++) {
			await kvPut(
				`traefik/http/services/${base}/loadbalancer/servers/${i}/url`,
				servers[i],
			);
		}
		await kvPut(
			`traefik/http/services/${base}/loadbalancer/passhostheader`,
			"true",
		);
		if (https) {
			await kvPut(`traefik/http/routers/${base}-web/rule`, rule);
			await kvPut(`traefik/http/routers/${base}-web/entrypoints/0`, "web");
			await kvPut(`traefik/http/routers/${base}-web/service`, base);
			await kvPut(
				`traefik/http/routers/${base}-web/middlewares/0`,
				"redirect-to-https@file",
			);
			await kvPut(`traefik/http/routers/${base}-secure/rule`, rule);
			await kvPut(
				`traefik/http/routers/${base}-secure/entrypoints/0`,
				"websecure",
			);
			await kvPut(`traefik/http/routers/${base}-secure/service`, base);
			await kvPut(
				`traefik/http/routers/${base}-secure/tls/certresolver`,
				resolverFor(d, defaultResolver),
			);
		} else {
			await kvPut(`traefik/http/routers/${base}/rule`, rule);
			await kvPut(`traefik/http/routers/${base}/entrypoints/0`, "web");
			await kvPut(`traefik/http/routers/${base}/service`, base);
		}
	}
};

/**
 * Write (or remove) the pack's domain routing into Traefik's dynamic dir (hub)
 * AND Consul KV (the HA pool). Called after a pack deploy/reload; idempotent.
 * Handles the hub (local fs + KV) and remote servers (base64 over SSH).
 */
export const applyPackDomains = async (
	compose: Pick<Compose, "appName" | "serverId"> & { domains?: Domain[] },
): Promise<void> => {
	const { DYNAMIC_TRAEFIK_PATH } = paths(!!compose.serverId);
	const fileName = `${compose.appName}-pack.yml`;
	const filePath = join(DYNAMIC_TRAEFIK_PATH, fileName);
	// Resolve live alloc backends so routing works for Nomad-native pack services.
	const backends = await resolvePackBackends(compose.appName).catch(
		() => undefined,
	);
	// HTTP-01 can't work behind the pool — use the DNS-01 resolver when configured.
	const defaultResolver = await getDefaultCertResolver().catch(
		() => "letsencrypt",
	);
	const yaml = buildPackDomainConfig(
		compose,
		compose.domains ?? [],
		backends,
		defaultResolver,
	);

	if (compose.serverId) {
		if (!yaml) {
			await execAsyncRemote(
				compose.serverId,
				`rm -f "${filePath}" 2>/dev/null || true`,
			);
			return;
		}
		const encoded = encodeBase64(yaml);
		await execAsyncRemote(
			compose.serverId,
			`mkdir -p "${DYNAMIC_TRAEFIK_PATH}" && echo "${encoded}" | base64 -d > "${filePath}"`,
		);
		return;
	}

	// Local (hub / control plane): write the hub file provider AND publish to
	// Consul KV so the HA pool serves the same routes.
	const domains = compose.domains ?? [];
	if (!yaml) {
		if (existsSync(filePath)) rmSync(filePath);
		await syncPackDomainsToConsulKV(
			compose.appName,
			[],
			backends,
			defaultResolver,
		).catch((e) => console.error("pack-domains: KV clear failed:", e));
		return;
	}
	// KV publish is cheap + idempotent (delete+put); always refresh it so the pool
	// tracks alloc moves. The file write is skipped when unchanged to avoid
	// churning the hub's file-provider reload.
	await syncPackDomainsToConsulKV(
		compose.appName,
		domains,
		backends,
		defaultResolver,
	).catch((e) => console.error("pack-domains: KV publish failed:", e));
	if (existsSync(filePath)) {
		try {
			if (readFileSync(filePath, "utf8") === yaml) return;
		} catch {}
	}
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(filePath, yaml);
};

/**
 * Periodically rewrite every Nomad-Pack compose's domain routing so it follows
 * its alloc(s) after a reschedule (the backend is the alloc's host address, which
 * changes when it moves). Change-aware (applyPackDomains skips unchanged files),
 * so it's cheap. Control-plane only; a no-op when no pack has domains.
 */
export const startPackDomainsLoop = (intervalSeconds = 60): NodeJS.Timeout => {
	const tick = async () => {
		try {
			const rows = await db.query.compose.findMany({
				where: eq(composeTable.composeType, "nomad-pack"),
				columns: { appName: true, serverId: true },
				with: { domains: true },
			});
			for (const c of rows) {
				if (!c.domains?.length) continue;
				await applyPackDomains(c).catch((e) =>
					console.error(`pack-domains: ${c.appName} reconcile failed:`, e),
				);
			}
		} catch (e) {
			console.error("pack-domains: reconcile loop error:", e);
		}
	};
	return setInterval(tick, intervalSeconds * 1000);
};
