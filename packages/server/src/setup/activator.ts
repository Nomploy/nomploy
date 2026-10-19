import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths } from "../constants";
import { discoverPanelDomain } from "../utils/builders/nomad-panel";
import { execAsync } from "../utils/process/execAsync";

const JOB_NAME = "nomploy-activator";
// Tiny Node runtime; the proxy uses only built-ins (http + global fetch).
const ACTIVATOR_IMAGE = "node:22-alpine";
// Static host port the activator listens on (not :8080/:8082/:8083 — those are
// the hub Traefik dashboard, Traefik metrics, and CrowdSec LAPI).
const ACTIVATOR_PORT = 8084;
const NOMAD_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";

/**
 * Wake-on-request activator. When enabled, a small always-on proxy runs on every
 * LB node registered in Consul with a LOWEST-priority catch-all Traefik router on
 * web+websecure. A real service's own router (priority = rule length, high) always
 * wins while it's awake; when a scale-to-zero service is sleeping its router is
 * gone, so the request falls through to the activator, which asks the panel to
 * wake the owning service and returns a "waking up, retry" page. `secret`
 * authenticates the activator → panel wake call.
 */
export type ActivatorConfig = {
	enabled: boolean;
	secret: string;
};

const DEFAULT_CONFIG: ActivatorConfig = { enabled: false, secret: "" };

const configPath = (): string =>
	path.join(paths().MAIN_TRAEFIK_PATH, "..", "activator", "config.json");

export const getActivatorConfig = (): ActivatorConfig => {
	try {
		const parsed = JSON.parse(
			readFileSync(configPath(), "utf8"),
		) as Partial<ActivatorConfig>;
		return {
			enabled: parsed.enabled === true,
			secret: typeof parsed.secret === "string" ? parsed.secret : "",
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
};

export const setActivatorConfig = (cfg: ActivatorConfig): ActivatorConfig => {
	const enabled = cfg.enabled === true;
	let secret = typeof cfg.secret === "string" ? cfg.secret.trim() : "";
	if (enabled && secret === "") secret = randomBytes(32).toString("hex");
	const normalized: ActivatorConfig = { enabled, secret };
	const file = configPath();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(normalized, null, 2), "utf8");
	return normalized;
};

/** The wake endpoint the activator calls (the panel's public domain). */
const panelWakeUrl = (): string => {
	const domain = discoverPanelDomain();
	return domain ? `https://${domain}/api/activator/wake` : "";
};

/**
 * The activator process: a minimal HTTP server. On any request it reads the Host,
 * fires a wake call to the panel (best-effort, non-blocking on the response body),
 * and returns 503 + Retry-After with a tiny auto-refreshing page so the client
 * retries — by then the real service's router is back and serves it directly.
 */
const activatorScript = (): string => `
const http = require("http");
const WAKE_URL = process.env.PANEL_WAKE_URL || "";
const SECRET = process.env.ACTIVATOR_SECRET || "";
const PORT = Number(process.env.PORT || ${ACTIVATOR_PORT});
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Waking up…</title></head><body style="font-family:system-ui,sans-serif;text-align:center;margin-top:18vh;color:#334155"><h2>Waking up…</h2><p>This service was asleep and is starting now. Retrying automatically…</p></body></html>';
http
  .createServer((req, res) => {
    const host = String(req.headers.host || "").split(":")[0];
    if (WAKE_URL && host) {
      fetch(WAKE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-activator-secret": SECRET },
        body: JSON.stringify({ host }),
      }).catch(() => {});
    }
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "3" });
    res.end(PAGE);
  })
  .listen(PORT, () => console.log("activator listening on " + PORT));
`;

/**
 * A Nomad SYSTEM job (one per LB node) running the activator, host-networked on a
 * static port, registered in Consul with a catch-all Traefik router at priority 1.
 */
export const generateActivatorJob = (cfg: ActivatorConfig): string => {
	const wakeUrl = panelWakeUrl();
	return `job "${JOB_NAME}" {
  datacenters = ["dc1"]
  type        = "system"

  # Run on every LB node (where ingress Traefik lives) so the catch-all is served
  # locally and survives a node loss.
  constraint {
    attribute = "\${meta.nomploy_lb}"
    value     = "true"
  }

  group "activator" {
    network {
      mode = "host"
      port "http" {
        static = ${ACTIVATOR_PORT}
      }
    }

    # Catch-all at the LOWEST priority: a real (awake) service's router outranks it
    # on every Host; a sleeping service (router gone) falls through to here.
    service {
      name     = "${JOB_NAME}"
      port     = "http"
      provider = "consul"
      tags = [
        "traefik.enable=true",
        "traefik.http.routers.activator-web.rule=HostRegexp(\`.+\`)",
        "traefik.http.routers.activator-web.entrypoints=web",
        "traefik.http.routers.activator-web.priority=1",
        "traefik.http.routers.activator-secure.rule=HostRegexp(\`.+\`)",
        "traefik.http.routers.activator-secure.entrypoints=websecure",
        "traefik.http.routers.activator-secure.priority=1",
        "traefik.http.routers.activator-secure.tls=true",
      ]

      check {
        type     = "tcp"
        interval = "30s"
        timeout  = "5s"
      }
    }

    task "activator" {
      driver = "docker"

      env {
        PORT             = "${ACTIVATOR_PORT}"
        PANEL_WAKE_URL   = "${wakeUrl}"
        ACTIVATOR_SECRET = "${cfg.secret}"
      }

      config {
        image        = "${ACTIVATOR_IMAGE}"
        network_mode = "host"
        args         = ["node", "/local/activator.js"]
      }

      template {
        destination = "local/activator.js"
        change_mode = "restart"
        data        = <<EOH
${activatorScript()}EOH
      }

      resources {
        cpu    = 50
        memory = 48
      }
    }
  }
}
`;
};

const nomadHeaders = (): Record<string, string> =>
	process.env.NOMAD_TOKEN ? { "X-Nomad-Token": process.env.NOMAD_TOKEN } : {};

/** Deploy or stop the activator to match the config. */
export const deployActivator = async (): Promise<void> => {
	const cfg = getActivatorConfig();
	if (!cfg.enabled || cfg.secret === "") {
		await stopActivator();
		return;
	}
	const spec = generateActivatorJob(cfg);
	const file = path.join(
		paths().MAIN_TRAEFIK_PATH,
		"..",
		"activator",
		"job.nomad.hcl",
	);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, spec, "utf8");
	await execAsync(`nomad job run "${file}"`);
};

export const stopActivator = async (): Promise<void> => {
	try {
		await fetch(
			`${NOMAD_ADDRESS.replace(/\/$/, "")}/v1/job/${JOB_NAME}?purge=true`,
			{ method: "DELETE", headers: nomadHeaders() },
		);
	} catch {
		// best-effort — if Nomad is unreachable the job will be reconciled later
	}
};
