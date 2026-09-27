import { encodeBase64 } from "../utils/docker/utils";
import { execAsync } from "../utils/process/execAsync";

const JOB_NAME = "nomploy-lb-controller";

/**
 * A Nomad `system` job that runs the HA LoadBalancer DNS controller
 * (dist/lb-controller.mjs) on every node. Each instance uses a Consul-session lock
 * so only one reconciles at a time; running everywhere means DNS management
 * survives the hub (panel) going down. Needs only Consul (local agent on the node)
 * — no Postgres/Nomad — reading the config the panel seeds to KV `nomploy/lb/config`.
 */
export const generateLbControllerJob = (opts: {
	image: string;
	consulToken?: string;
}): string => {
	const token = opts.consulToken ?? "";
	return `job "${JOB_NAME}" {
  datacenters = ["dc1"]
  type        = "system"

  group "controller" {
    network {
      mode = "host"
    }

    task "controller" {
      driver = "docker"

      config {
        image        = "${opts.image}"
        force_pull   = true
        network_mode = "host"
        command      = "node"
        args         = ["dist/lb-controller.mjs"]
      }

      env {
        CONSUL_TOKEN     = "${token}"
        CONSUL_HTTP_ADDR = "http://127.0.0.1:8500"
      }

      resources {
        cpu    = 50
        memory = 64
      }
    }
  }
}
`;
};

const panelImage = (): string =>
	process.env.NOMPLOY_IMAGE || "ghcr.io/nomploy/nomploy:latest";

/** Deploy (or update) the HA LB controller system job on the control plane. */
export const deployLbControllerJob = async (): Promise<void> => {
	const hcl = generateLbControllerJob({
		image: panelImage(),
		consulToken: process.env.CONSUL_TOKEN,
	});
	const encoded = encodeBase64(hcl);
	const jobFilePath = `/etc/nomploy/jobs/${JOB_NAME}.nomad.hcl`;
	const command = `
set -e
mkdir -p /etc/nomploy/jobs
echo "${encoded}" | base64 -d > "${jobFilePath}"
if ! nomad job run "${jobFilePath}" 2>&1; then
	echo "Error: LB controller job deployment failed"
	exit 1
fi
echo "LB controller system job deployed"
`;
	await execAsync(command);
};

/** Stop + purge the HA LB controller system job. */
export const stopLbControllerJob = async (): Promise<void> => {
	await execAsync(`nomad job stop -purge ${JOB_NAME} 2>&1 || true`);
};

export const LB_CONTROLLER_JOB_NAME = JOB_NAME;
