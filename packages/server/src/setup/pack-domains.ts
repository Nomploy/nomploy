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

/**
 * The Consul service names a Nomad Pack deployment registers. A pack's jobs are
 * named after the pack, not the appName, so we find them by the
 * `pack.deployment_name == appName` meta, then read each job's service stanzas.
 * These are what a domain routes to (via `<name>.service.consul`).
 */
export const loadPackServices = async (appName: string): Promise<string[]> => {
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
	const names = new Set<string>();
	for (const id of ids) {
		try {
			const job = await nomadFetch<{
				TaskGroups?: {
					Services?: { Name?: string }[];
					Tasks?: { Services?: { Name?: string }[] }[];
				}[];
			}>(`/job/${encodeURIComponent(id)}`);
			for (const tg of job.TaskGroups ?? []) {
				for (const s of tg.Services ?? []) if (s.Name) names.add(s.Name);
				for (const t of tg.Tasks ?? [])
					for (const s of t.Services ?? []) if (s.Name) names.add(s.Name);
			}
		} catch {
			// skip unreadable job
		}
	}
	return [...names];
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
