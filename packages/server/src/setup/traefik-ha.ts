import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { paths } from "../constants";
import { encodeBase64 } from "../utils/docker/utils";
import { execAsync } from "../utils/process/execAsync";
import { TRAEFIK_VERSION } from "./traefik-setup";

const JOB_NAME = "nomploy-traefik-ha";
const CONSUL_ADDR = "http://127.0.0.1:8500";
// Traefik's own consul KV provider (rootKey "traefik") reads the shared TLS certs
// straight from here, using the token in its config — NOT via Nomad's template
// `key` integration (that uses a different, KV-less Consul token and 403s). Certs
// live as a Traefik dynamic-config subtree: traefik/tls/certificates/<i>/certFile.
const KV_CERTS_PREFIX = "traefik/tls/certificates";

const consulToken = (): string => process.env.CONSUL_TOKEN ?? "";

/**
 * The ACME contact email for the LB nodes' `letsencrypt` resolver. The resolver
 * only has to *exist* so the catalog routers' `tls.certresolver=letsencrypt`
 * tags validate — certs are served from the KV store, so it stays dormant.
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
 * Providers:
 *  - `consulCatalog` — routing, discovered from the local Consul catalog.
 *  - `consul` (KV, rootKey "traefik") — shared TLS certs, seeded from the hub's
 *    acme.json. Traefik reads these with the token in its config (works), so we
 *    avoid Nomad's template `key` integration entirely (that uses a different
 *    Consul token that lacks KV read → 403, killing the task).
 *  - `file` — the `redirect-to-https` middleware, rendered as a *static* template
 *    (no consul lookup). Required because the panel's router pins the middleware
 *    to `redirect-to-https@file`.
 *
 * A `letsencrypt` resolver is defined so catalog routers referencing it validate;
 * with certs pre-seeded in the KV store it never issues. Everything renders into
 * the task dir (auto-mounted at /local) — no host bind.
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
  metrics:
    address: ":8082"
metrics:
  prometheus:
    entryPoint: metrics
    addEntryPointsLabels: true
    addServicesLabels: true
providers:
  consulCatalog:
    endpoint:
      address: "http://127.0.0.1:8500"
      token: "${token}"
    exposedByDefault: false
    prefix: traefik
    refreshInterval: "5s"
  consul:
    endpoints:
      - "127.0.0.1:8500"
    token: "${token}"
    rootKey: "traefik"
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
        destination = "local/dynamic.yml"
        change_mode = "noop"
        data        = <<EOH
http:
  middlewares:
    redirect-to-https:
      redirectScheme:
        scheme: https
        permanent: true
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

const consulHeaders = (): Record<string, string> => {
	const token = consulToken();
	return token ? { "X-Consul-Token": token } : {};
};

const consulKvPut = async (key: string, value: string): Promise<void> => {
	const res = await fetch(`${CONSUL_ADDR}/v1/kv/${key}`, {
		method: "PUT",
		headers: consulHeaders(),
		body: value,
	});
	if (!res.ok) {
		throw new Error(`Consul KV PUT ${key} failed: HTTP ${res.status}`);
	}
};

const consulKvDeleteTree = async (prefix: string): Promise<void> => {
	const res = await fetch(`${CONSUL_ADDR}/v1/kv/${prefix}?recurse=true`, {
		method: "DELETE",
		headers: consulHeaders(),
	});
	if (!res.ok && res.status !== 404) {
		throw new Error(`Consul KV DELETE ${prefix} failed: HTTP ${res.status}`);
	}
};

/** Decode every live cert from the hub's acme.json (base64 PEM per Traefik's
 * on-disk format) into inline PEM strings. */
const readAcmeCertificates = (): { cert: string; key: string }[] => {
	const out: { cert: string; key: string }[] = [];
	try {
		const acmePath = path.join(paths().MAIN_TRAEFIK_PATH, "acme.json");
		if (!existsSync(acmePath)) return out;
		const acme = JSON.parse(readFileSync(acmePath, "utf8")) as Record<
			string,
			{ Certificates?: { certificate?: string; key?: string }[] }
		>;
		for (const resolver of Object.values(acme)) {
			for (const c of resolver?.Certificates ?? []) {
				if (!c?.certificate || !c?.key) continue;
				out.push({
					cert: Buffer.from(c.certificate, "base64").toString("utf8"),
					key: Buffer.from(c.key, "base64").toString("utf8"),
				});
			}
		}
	} catch (e) {
		console.error("traefik-ha: failed to read acme.json for cert sync:", e);
	}
	return out;
};

/**
 * Seed/refresh the LB pool's shared certs into Consul KV as a Traefik dynamic-
 * config subtree (traefik/tls/certificates/<i>/certFile|keyFile, inline PEM).
 * Traefik's `consul` KV provider serves them directly and hot-reloads on change.
 * Idempotent — clears the subtree first so removed certs don't linger.
 */
export const syncTraefikCertsToConsulKV = async (): Promise<{
	certCount: number;
}> => {
	const certs = readAcmeCertificates();
	await consulKvDeleteTree(KV_CERTS_PREFIX);
	// Drop the stale single-blob key from the earlier design, if present.
	await consulKvDeleteTree("traefik/dynamic-config");
	let i = 0;
	for (const c of certs) {
		await consulKvPut(`${KV_CERTS_PREFIX}/${i}/certFile`, c.cert);
		await consulKvPut(`${KV_CERTS_PREFIX}/${i}/keyFile`, c.key);
		i++;
	}
	return { certCount: certs.length };
};

/**
 * Deploy (or update) the HA Traefik system job on the control plane. Seeds the
 * shared certs into Consul KV first, then writes the HCL and `nomad job run`s it.
 * Runs on nodes tagged nomploy_lb=true; a no-op on a cluster with no such nodes.
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
