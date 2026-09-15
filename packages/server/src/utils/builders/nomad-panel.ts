import { existsSync, readFileSync } from "node:fs";
import { encodeBase64 } from "../docker/utils";

// The panel's Traefik file route (written at install), the single place that
// currently holds the panel's public domain. We read the Host rule from it to
// build the Consul routing tags for zero-downtime deploys — see discoverPanelDomain.
const PANEL_TRAEFIK_ROUTE = "/etc/nomploy/traefik/dynamic/nomploy.yml";

/**
 * The panel's public domain, discovered from its existing Traefik file route
 * (bind-mounted at /etc/nomploy). Returns undefined if the file/rule isn't found
 * — callers then fall back to the legacy host-static job (no behavior change).
 * This avoids needing a new config value: the domain the user already configured
 * for the panel is reused for the Consul-routed, canary-deployable job.
 */
export const discoverPanelDomain = (): string | undefined => {
	try {
		if (!existsSync(PANEL_TRAEFIK_ROUTE)) return undefined;
		const yml = readFileSync(PANEL_TRAEFIK_ROUTE, "utf8");
		const m = yml.match(/Host\(`([^`]+)`\)/);
		return m?.[1] || undefined;
	} catch {
		return undefined;
	}
};

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
	// Nomad/Consul ACL tokens (empty until ACLs are enabled). Must be carried on
	// self-update or a Reload would drop them and lock the panel out of the APIs.
	"NOMAD_TOKEN",
	"CONSUL_TOKEN",
	// Least-privilege token the panel re-launches the Nomad Autoscaler with
	// (initializeNomadAutoscaler); carried so a self-update doesn't drop it.
	"NOMAD_AUTOSCALER_TOKEN",
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
 * Resolve the image the panel job should run, based on NOMPLOY_IMAGE (how the
 * panel was actually installed, e.g. ghcr.io/nomploy/nomploy:latest).
 *
 * With no `tag` it returns NOMPLOY_IMAGE unchanged — the right choice for a
 * reload/restart: keep the current image and let the job's force_pull re-pull a
 * moving tag (:latest, :canary) to its newest digest. Do NOT feed it
 * packageInfo.version — release version tags (v0.29.7) are not pushed to the
 * registry, only :latest and :sha-*, so mapping to one yields a "not found" pull.
 *
 * A `tag` is only for an explicit retag (swaps the tag, keeping repo+registry).
 */
export const resolvePanelImage = (
	tag?: string,
	env: NodeJS.ProcessEnv = process.env,
): string => {
	const current = env.NOMPLOY_IMAGE || "ghcr.io/nomploy/nomploy:latest";
	if (!tag) return current;
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
	panelDomain?: string,
): string => {
	// Zero-downtime mode: when we know the panel's domain we route it through
	// Consul (dynamic port + Traefik tags) and deploy with a CANARY — a new alloc
	// starts alongside the old, both stay in the Consul load-balancer pool, and the
	// old is only drained once the canary is healthy (auto_promote). So a self-
	// update never drops the single backend the way the host-static job does.
	// Without a domain we can't build the Host tag, so fall back to the legacy
	// host-networked static-3000 job (routed by the Traefik file route) unchanged.
	const zeroDowntime = !!panelDomain;

	// Dynamic port + Consul service (only in zero-downtime mode).
	const networkBlock = zeroDowntime
		? `    network {
      mode = "host"
      port "http" {}
    }
`
		: "";
	// The app binds NOMAD_PORT_http (auto-injected by Nomad from the port block)
	// when it's set, so two panels get distinct ports during a canary swap — no
	// PORT override needed here (env-stanza ${NOMAD_PORT_http} interpolation is
	// unreliable in host networking; see server.ts).
	const panelEnv = env;
	// priority 100 so these Consul routers win over the legacy file route (same Host
	// rule) once the canary is healthy; the file route stays as a harmless fallback.
	const serviceBlock = zeroDowntime
		? `    service {
      name     = "${PANEL_JOB_NAME}"
      port     = "http"
      provider = "consul"
      tags = [
        "traefik.enable=true",
        "traefik.http.routers.nomploy-web.rule=Host(\`${panelDomain}\`)",
        "traefik.http.routers.nomploy-web.entrypoints=web",
        "traefik.http.routers.nomploy-web.middlewares=redirect-to-https@file",
        "traefik.http.routers.nomploy-web.priority=100",
        "traefik.http.routers.nomploy-secure.rule=Host(\`${panelDomain}\`)",
        "traefik.http.routers.nomploy-secure.entrypoints=websecure",
        "traefik.http.routers.nomploy-secure.tls.certresolver=letsencrypt",
        "traefik.http.routers.nomploy-secure.priority=100",
      ]

      check {
        type     = "tcp"
        port     = "http"
        interval = "10s"
        timeout  = "3s"
      }
    }
`
		: "";
	const portsConfig = zeroDowntime ? '\n        ports        = ["http"]' : "";

	// Canary rollout only in zero-downtime mode; health gated on the Consul check.
	const updateBlock = zeroDowntime
		? `  update {
    max_parallel     = 1
    canary           = 1
    auto_promote     = true
    health_check     = "checks"
    min_healthy_time = "10s"
    healthy_deadline = "5m"
    progress_deadline = "10m"
    auto_revert      = true
  }`
		: `  update {
    max_parallel     = 1
    health_check     = "task_states"
    min_healthy_time = "10s"
    healthy_deadline = "3m"
    auto_revert      = true
  }`;

	return `job "${PANEL_JOB_NAME}" {
  namespace = "default"
  type      = "service"

  // Pin the panel to the control-plane node — it reaches Postgres/Redis/Consul/
  // Nomad on 127.0.0.1 and manages the host's WireGuard, so it must never be
  // scheduled onto a worker. The server node carries meta.nomploy_control_plane
  // (install.sh); worker nodes (nomad-cluster.ts) do not.
  constraint {
    attribute = "\${meta.nomploy_control_plane}"
    value     = "true"
  }

  // Bumped on every submit so re-running with an unchanged image (e.g. a moving
  // :latest tag) still produces a new deployment — combined with force_pull, a
  // "reload" always restarts on the current digest.
  meta {
    deployed_at = ${JSON.stringify(deployedAt)}
  }

${updateBlock}

  group "${PANEL_JOB_NAME}" {
    count = 1

    restart {
      attempts = 3
      interval = "5m"
      delay    = "15s"
      mode     = "delay"
    }
${networkBlock}${serviceBlock}
    task "${PANEL_JOB_NAME}" {
      driver = "docker"

      config {
        image        = ${JSON.stringify(image)}
        force_pull   = true
        network_mode = "host"
        privileged   = true${portsConfig}
        volumes = [
          "/var/run/docker.sock:/var/run/docker.sock",
          "/etc/nomploy:/etc/nomploy",
          "/etc/wireguard:/etc/wireguard",
        ]
      }

${generateEnvBlock(panelEnv)}

      kill_timeout = "30s"

      // CPU is a scheduling FLOOR, not a cap — the panel bursts above it freely.
      // In zero-downtime mode a CANARY must fit alongside the running panel on the
      // (often small) single control-plane node, so reserve a smaller floor (500)
      // that lets two coexist during the brief swap; legacy mode keeps 1000.
      // memory is the reservation; memory_max is the hard cgroup cap the panel can
      // burst to (Node's heap grows past 512 MB under load; a 1024 MB cap
      // OOM-killed it). Bursting needs memory oversubscription (install.sh enables it).
      resources {
        cpu        = ${zeroDowntime ? 500 : 1000}
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
	panelDomain: string | undefined = discoverPanelDomain(),
): string => {
	const encoded = encodeBase64(
		generatePanelNomadJob(image, env, undefined, panelDomain),
	);
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
