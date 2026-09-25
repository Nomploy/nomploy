import { encodeBase64 } from "../utils/docker/utils";
import { execAsync } from "../utils/process/execAsync";
import { TRAEFIK_VERSION } from "./traefik-setup";

const JOB_NAME = "nomploy-traefik-ha";

/**
 * A Nomad `system` job that runs one Traefik per node tagged `meta.nomploy_lb =
 * "true"` — the HA "LoadBalancer" ingress pool. The hub is deliberately excluded
 * (it runs the standalone `nomploy-traefik`) so this never clashes on :80/:443
 * there. Each instance reads routing from the local Consul catalog and shared TLS
 * certs from Consul KV (populated out-of-band in Phase 2c); it does NOT run ACME —
 * these instances serve certs, they don't issue them. Config is rendered into the
 * task dir (auto-mounted at /local), so no host bind / docker volumes needed.
 */
export const generateTraefikHaJob = (opts: {
	consulToken?: string;
}): string => {
	const token = opts.consulToken ?? "";
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
  consul:
    endpoints:
      - "127.0.0.1:8500"
    token: "${token}"
    rootKey: "traefik"
api:
  insecure: true
  dashboard: true
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
 * Deploy (or update) the HA Traefik system job on the control plane. Mirrors the
 * DB/app build pipeline: write the HCL, then `nomad job run`. Runs on nodes tagged
 * nomploy_lb=true; a no-op on a cluster with no such nodes.
 */
export const deployTraefikHaSystemJob = async (): Promise<void> => {
	const hcl = generateTraefikHaJob({ consulToken: process.env.CONSUL_TOKEN });
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
};

/** Stop + purge the HA Traefik system job (removes it from every LB node). */
export const stopTraefikHaSystemJob = async (): Promise<void> => {
	await execAsync(`nomad job stop -purge ${JOB_NAME} 2>&1 || true`);
};

export const TRAEFIK_HA_JOB_NAME = JOB_NAME;
