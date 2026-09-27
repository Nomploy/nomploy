import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { paths } from "../constants";
import type {
	compose as composeTable,
	domains as domainsTable,
} from "../db/schema";
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

const resolverFor = (d: Domain): string =>
	d.certificateType === "custom" && d.customCertResolver
		? d.customCertResolver
		: "letsencrypt";

/**
 * Build a Traefik file-provider dynamic config that routes each of the pack's
 * domains to its Consul service. The backend is `<service>.service.consul:<port>`
 * so Consul resolves it to the currently-healthy alloc(s) — robust across
 * reschedules. HTTPS domains get a LE cert resolver + an HTTP→HTTPS redirect.
 */
export const buildPackDomainConfig = (
	compose: Pick<Compose, "appName">,
	domains: Domain[],
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

		services[base] = {
			loadBalancer: {
				servers: [{ url: `http://${d.serviceName}.service.consul:${port}` }],
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
				tls: { certResolver: resolverFor(d) },
			};
		} else {
			routers[base] = { rule, entryPoints: ["web"], service: base };
		}
	}

	if (!any) return null;
	return stringify({ http: { routers, services } });
};

/**
 * Write (or remove) the pack's domain routing into Traefik's dynamic dir. Called
 * after a pack deploy/reload; idempotent. Handles the hub (local fs) and remote
 * servers (base64 over SSH).
 */
export const applyPackDomains = async (
	compose: Pick<Compose, "appName" | "serverId"> & { domains?: Domain[] },
): Promise<void> => {
	const { DYNAMIC_TRAEFIK_PATH } = paths(!!compose.serverId);
	const fileName = `${compose.appName}-pack.yml`;
	const filePath = join(DYNAMIC_TRAEFIK_PATH, fileName);
	const yaml = buildPackDomainConfig(compose, compose.domains ?? []);

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

	// Local (hub / control plane).
	if (!yaml) {
		if (existsSync(filePath)) rmSync(filePath);
		return;
	}
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(filePath, yaml);
};
