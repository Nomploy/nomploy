import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { paths } from "../constants";
import { encodeBase64 } from "../utils/docker/utils";
import { execAsync } from "../utils/process/execAsync";
import { TRAEFIK_VERSION } from "./traefik-setup";

const JOB_NAME = "nomploy-traefik-ha";
const CONSUL_ADDR = "http://127.0.0.1:8500";
// Traefik reads its shared dynamic config (redirect middleware + TLS certs) from
// this single Consul KV key; the Nomad template renders it into the task dir and
// Traefik's file provider hot-reloads it. One key keeps the render trivial and
// lets us build the YAML precisely here in TS (inline PEM, exact indentation).
const KV_DYNAMIC_KEY = "traefik/dynamic-config";

const consulToken = (): string => process.env.CONSUL_TOKEN ?? "";

/**
 * The ACME contact email for the LB nodes' `letsencrypt` resolver. The resolver
 * only has to *exist* so the catalog routers' `tls.certresolver=letsencrypt`
 * tags validate — certs are served from the shared store, so it stays dormant.
 * Mirror the hub's email when we can read it; fall back to a sane default.
 */
const resolveAcmeEmail = (): string => {
	try {
		const mainTraefik = path.join(paths().MAIN_TRAEFIK_PATH, "traefik.yml");
		if (existsSync(mainTraefik)) {
			const m = readFileSync(mainTraefik, "utf8").match(
				/email:\s*["']?([^\s"']+@[^\s"']+)["']?/,
			);
			if (m?.[1]) return m[1];
		}
	} catch {
		// fall through to default
	}
	return "admin@localhost";
};

/**
 * A Nomad `system` job that runs one Traefik per node tagged `meta.nomploy_lb =
 * "true"` — the HA "LoadBalancer" ingress pool. The hub is deliberately excluded
 * (it runs the standalone `nomploy-traefik`) so this never clashes on :80/:443
 * there.
 *
 * Routing comes from the local Consul catalog (`consulCatalog`). Shared TLS certs
 * and the `redirect-to-https` middleware come from a file provider fed by a Nomad
 * template that renders {@link KV_DYNAMIC_KEY} from Consul KV — the file provider
 * (not KV) is required because the panel's own router pins the middleware to
 * `redirect-to-https@file`. A `letsencrypt` resolver is defined so catalog routers
 * that reference it validate; with certs pre-seeded in the store it never issues.
 * Everything renders into the task dir (auto-mounted at /local) — no host bind.
 */
export const generateTraefikHaJob = (opts: {
	consulToken?: string;
	email?: string;
}): string => {
	const token = opts.consulToken ?? "";
	const email = opts.email ?? "admin@localhost";
	return `job "${JOB_NAME}" {
  datacenters = ["dc1"]
  type        = "system"

  constraint {
    attribute = "\${meta.nomploy_lb}"
    value     = "true"
  }

  group "traefik" {
    network {
      mode = "host"
    }

    task "traefik" {
      driver = "docker"

      config {
        image        = "traefik:v${TRAEFIK_VERSION}"
        network_mode = "host"
        args         = ["--configFile=/local/traefik.yml"]
      }

      template {
        destination = "local/traefik.yml"
        change_mode = "restart"
        data        = <<EOH
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
providers:
  consulCatalog:
    endpoint:
      address: "http://127.0.0.1:8500"
      token: "${token}"
    exposedByDefault: false
    prefix: traefik
    refreshInterval: "5s"
  file:
    filename: "/local/dynamic.yml"
    watch: true
certificatesResolvers:
  letsencrypt:
    acme:
      email: "${email}"
      storage: "/local/acme.json"
      httpChallenge:
        entryPoint: web
api:
  insecure: true
  dashboard: true
EOH
      }

      template {
        destination   = "local/dynamic.yml"
        change_mode   = "noop"
        left_delimiter  = "[[["
        right_delimiter = "]]]"
        data          = <<EOH
[[[ key "${KV_DYNAMIC_KEY}" ]]]
EOH
      }

      resources {
        cpu    = 200
        memory = 256
      }
    }
  }
}
`;
};

/**
 * Build the Traefik dynamic-config document the LB pool serves: the
 * `redirect-to-https` middleware (mirrors the hub's file provider so
 * `redirect-to-https@file` resolves) plus every live cert as an inline-PEM entry.
 * Certs are read from the hub's acme.json (base64 PEM per Traefik's on-disk
 * format) and decoded here. Traefik's `FileOrContent` fields accept raw PEM
 * content, so no per-cert files are needed.
 */
const buildDynamicConfig = (): { yaml: string; certCount: number } => {
	const doc: {
		http: { middlewares: Record<string, unknown> };
		tls?: { certificates: { certFile: string; keyFile: string }[] };
	} = {
		http: {
			middlewares: {
				"redirect-to-https": {
					redirectScheme: { scheme: "https", permanent: true },
				},
			},
		},
	};

	const certificates: { certFile: string; keyFile: string }[] = [];
	try {
		const acmePath = path.join(paths().MAIN_TRAEFIK_PATH, "acme.json");
		if (existsSync(acmePath)) {
			const acme = JSON.parse(readFileSync(acmePath, "utf8")) as Record<
				string,
				{ Certificates?: { certificate?: string; key?: string }[] }
			>;
			for (const resolver of Object.values(acme)) {
				for (const c of resolver?.Certificates ?? []) {
					if (!c?.certificate || !c?.key) continue;
					certificates.push({
						certFile: Buffer.from(c.certificate, "base64").toString("utf8"),
						keyFile: Buffer.from(c.key, "base64").toString("utf8"),
					});
				}
			}
		}
	} catch (e) {
		console.error("traefik-ha: failed to read acme.json for cert sync:", e);
	}
	if (certificates.length > 0) doc.tls = { certificates };

	return { yaml: stringify(doc), certCount: certificates.length };
};

const consulKvPut = async (key: string, value: string): Promise<void> => {
	const token = consulToken();
	const res = await fetch(`${CONSUL_ADDR}/v1/kv/${key}`, {
		method: "PUT",
		headers: token ? { "X-Consul-Token": token } : {},
		body: value,
	});
	if (!res.ok) {
		throw new Error(`Consul KV PUT ${key} failed: HTTP ${res.status}`);
	}
};

/**
 * Seed/refresh the LB pool's shared dynamic config (middleware + current certs)
 * into Consul KV. Idempotent — overwrites the single key. Re-run after cert
 * renewals so the pool picks up fresh certs (the file provider hot-reloads).
 */
export const syncTraefikCertsToConsulKV = async (): Promise<{
	certCount: number;
}> => {
	const { yaml, certCount } = buildDynamicConfig();
	await consulKvPut(KV_DYNAMIC_KEY, yaml);
	return { certCount };
};

/**
 * Deploy (or update) the HA Traefik system job on the control plane. Seeds the
 * shared dynamic config into Consul KV first (the template `key` lookup blocks
 * until it exists), then writes the HCL and `nomad job run`s it. Runs on nodes
 * tagged nomploy_lb=true; a no-op on a cluster with no such nodes.
 */
export const deployTraefikHaSystemJob = async (): Promise<{
	certCount: number;
}> => {
	const { certCount } = await syncTraefikCertsToConsulKV();
	const hcl = generateTraefikHaJob({
		consulToken: consulToken(),
		email: resolveAcmeEmail(),
	});
	const encoded = encodeBase64(hcl);
	const jobFilePath = `/etc/nomploy/jobs/${JOB_NAME}.nomad.hcl`;
	const command = `
set -e
mkdir -p /etc/nomploy/jobs
echo "${encoded}" | base64 -d > "${jobFilePath}"
if ! nomad job run "${jobFilePath}" 2>&1; then
	echo "Error: Traefik HA job deployment failed"
	exit 1
fi
echo "Traefik HA system job deployed"
`;
	await execAsync(command);
	return { certCount };
};

/** Stop + purge the HA Traefik system job (removes it from every LB node). */
export const stopTraefikHaSystemJob = async (): Promise<void> => {
	await execAsync(`nomad job stop -purge ${JOB_NAME} 2>&1 || true`);
};

export const TRAEFIK_HA_JOB_NAME = JOB_NAME;
