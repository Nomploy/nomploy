import { encodeBase64 } from "../docker/utils";

// The panel (nomploy itself) runs as a Nomad job named "nomploy" so it can
// self-update the Dokploy way: `nomad job run` with a new image pulls it and
// rolling-restarts the allocation in place — the Nomad equivalent of Swarm's
// `docker service update --image`. No manual pull + recreate.
export const PANEL_JOB_NAME = "nomploy";

// Where the panel writes its own job file. /etc/nomploy is bind-mounted into the
// container and persists on the host, so the file survives allocation restarts.
export const PANEL_JOB_FILE = "/etc/nomploy/nomploy.nomad.hcl";

// The panel is a privileged host agent: it drives the Docker socket, manages the
// WireGuard mesh (needs NET_ADMIN + /etc/wireguard), and talks to Nomad/Consul on
// the host network. `privileged = true` grants those capabilities without a
// cluster-wide `allow_caps` change — the Nomad docker plugin already runs with
// `allow_privileged = true` (see install.sh). It mirrors exactly what the
// `docker run` bootstrap gave the container.
//
// The three host bind mounts below additionally require the docker plugin's
// `volumes { enabled = true }` (also set in install.sh) — it defaults to false,
// which rejects host-path volumes with "volumes are not enabled".
const PANEL_ENV_KEYS = [
	"NODE_ENV",
	"PORT",
	"DATABASE_URL",
	"REDIS_HOST",
	"BETTER_AUTH_SECRET",
	"NOMAD_ADDRESS",
	"CONSUL_ADDRESS",
	// Single source of truth for the panel's own image repo, so a self-update can
	// re-tag it (see resolvePanelImage). Passed through by install.sh.
	"NOMPLOY_IMAGE",
	// Optional: canary/feature channel selection, kept if present.
	"RELEASE_TAG",
] as const;

/**
 * Collect the panel's runtime env from the current process, so a self-issued
 * `nomad job run` reproduces the exact environment the panel is running with
 * (DB URL, auth secret, Nomad/Consul addresses, …). Only defined values are
 * carried; missing ones are simply omitted.
 */
export const collectPanelEnv = (
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const key of PANEL_ENV_KEYS) {
		const value = env[key];
		if (value !== undefined && value !== "") out[key] = value;
	}
	// PORT defaults to 3000 to match the Dockerfile / install.sh.
	if (!out.PORT) out.PORT = "3000";
	if (!out.NODE_ENV) out.NODE_ENV = "production";
	return out;
};

/**
 * Resolve the image the panel job should run. Reuses the repo the panel was
 * started with (NOMPLOY_IMAGE, e.g. ghcr.io/nomploy/nomploy:latest) and swaps in
 * `tag`, so the registry always matches how it was actually installed instead of
 * a hardcoded Docker Hub reference.
 */
export const resolvePanelImage = (
	tag: string,
	env: NodeJS.ProcessEnv = process.env,
): string => {
	const current = env.NOMPLOY_IMAGE || "ghcr.io/nomploy/nomploy:latest";
	// Strip an existing :tag (but not a registry :port) — split on the last colon
	// only if what follows has no "/".
	const lastColon = current.lastIndexOf(":");
	const repo =
		lastColon > current.lastIndexOf("/")
			? current.slice(0, lastColon)
			: current;
	return `${repo}:${tag}`;
};

const generateEnvBlock = (env: Record<string, string>): string => {
	const lines = Object.entries(env)
		.map(([key, value]) => `        ${key} = ${JSON.stringify(value)}`)
		.join("\n");
	return `      env {\n${lines}\n      }`;
};

/**
 * The panel's Nomad job HCL. A singleton (count = 1) on the control-plane node,
 * host-networked and privileged, with the same three bind mounts the docker-run
 * bootstrap used. `update.auto_revert` rolls back to the previous image if the
 * new allocation never becomes healthy.
 *
 * v1 assumption: a single control-plane node (bootstrap_expect = 1). Multi-node
 * clusters need a constraint pinning this to the node that hosts Postgres/Redis/
 * Consul — a follow-up.
 */
export const generatePanelNomadJob = (
	image: string,
	env: Record<string, string>,
	deployedAt: string = new Date().toISOString(),
): string => {
	return `job "${PANEL_JOB_NAME}" {
  namespace = "default"
  type      = "service"

  // Bumped on every submit so re-running with an unchanged image (e.g. a moving
  // :latest tag) still produces a new deployment — combined with force_pull, a
  // "reload" always restarts on the current digest.
  meta {
    deployed_at = ${JSON.stringify(deployedAt)}
  }

  update {
    max_parallel     = 1
    health_check     = "task_states"
    min_healthy_time = "10s"
    healthy_deadline = "3m"
    auto_revert      = true
  }

  group "${PANEL_JOB_NAME}" {
    count = 1

    restart {
      attempts = 3
      interval = "5m"
      delay    = "15s"
      mode     = "delay"
    }

    task "${PANEL_JOB_NAME}" {
      driver = "docker"

      config {
        image        = ${JSON.stringify(image)}
        force_pull   = true
        network_mode = "host"
        privileged   = true
        volumes = [
          "/var/run/docker.sock:/var/run/docker.sock",
          "/etc/nomploy:/etc/nomploy",
          "/etc/wireguard:/etc/wireguard",
        ]
      }

${generateEnvBlock(env)}

      kill_timeout = "30s"

      // memory is the scheduling reservation; memory_max is the hard cgroup cap
      // the panel can burst to (Node's heap grows well past 512 MB under load —
      // a 1024 MB hard limit OOM-killed it). Bursting above the reservation
      // needs the cluster's memory oversubscription enabled (install.sh does:
      // \`nomad operator scheduler set-config -memory-oversubscription=true\`).
      resources {
        cpu        = 1000
        memory     = 512
        memory_max = 2048
      }
    }
  }
}
`;
};

/**
 * Shell command that writes the panel job file and submits it to Nomad. Used
 * both by the self-update path and (rendered inline) by install.sh's bootstrap.
 */
export const getPanelNomadDeployCommand = (
	image: string,
	env: Record<string, string>,
): string => {
	const encoded = encodeBase64(generatePanelNomadJob(image, env));
	return `
set -e
{
	mkdir -p "$(dirname "${PANEL_JOB_FILE}")"
	echo "${encoded}" | base64 -d > "${PANEL_JOB_FILE}"
	echo "Panel Nomad job file written: ✅"
	nomad job run "${PANEL_JOB_FILE}" 2>&1
	echo "Panel Nomad Job Submitted: ✅"
} || {
	echo "Error: ❌ Panel Nomad deployment failed"
	exit 1
}
`;
};
