import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { paths } from "../constants";
import { encodeBase64 } from "../utils/docker/utils";
import { execAsync } from "../utils/process/execAsync";
import { readMainConfig, writeMainConfig } from "../utils/traefik/web-server";
import { initializeStandaloneTraefik } from "./traefik-setup";

const JOB_NAME = "nomploy-crowdsec";

// Pinned CrowdSec release. The image bundles both the Local API (LAPI) and a
// local agent; in Phase 1 we run them together on the hub as a pure detector
// (it parses the hub Traefik access log into decisions, but nothing enforces
// them yet). Bump deliberately — a major bump can change config/data-dir rules
// (e.g. 1.7 made the data volume mandatory, which we already mount).
const CROWDSEC_IMAGE = "crowdsecurity/crowdsec:v1.6.8";

// Where CrowdSec reads the hub Traefik access log from, inside the container.
// We bind the hub's dynamic dir (which holds access.log) read-only here.
const CONTAINER_LOG_DIR = "/logs/traefik";
const HUB_ACCESS_LOG = "/etc/nomploy/traefik/dynamic/access.log";

/**
 * Persisted CrowdSec settings.
 *
 * Phase 1 only uses `enabled` (run the detector on the hub) — `enforce`,
 * `bouncerKey` and `allowlist` are persisted now so a later phase can turn on
 * the Traefik bouncer middleware (globally or per app/service) without a
 * migration. `bouncerKey` is generated on first enable and pre-registered with
 * LAPI (`BOUNCER_KEY_traefik`) so the bouncer can authenticate when we wire it.
 */
export type CrowdsecConfig = {
	/** Run CrowdSec (LAPI + agent) on the hub, parsing the hub access log. */
	enabled: boolean;
	/**
	 * Whether the (future) bouncer middleware actually blocks. Detection-only
	 * while false — decisions are collected and listed but never enforced.
	 */
	enforce: boolean;
	/** Pre-generated API key for the Traefik bouncer plugin (Phase 3). */
	bouncerKey: string;
	/**
	 * Extra CIDRs/IPs that must never be blocked (anti-lockout). The WireGuard
	 * overlay subnet is always allowlisted on top of this, so the cluster can
	 * never ban itself; an operator adds their own admin IP here.
	 */
	allowlist: string[];
};

const DEFAULT_CROWDSEC_CONFIG: CrowdsecConfig = {
	enabled: false,
	enforce: false,
	bouncerKey: "",
	allowlist: [],
};

// The WireGuard overlay subnet (hub .1, servers .2-.10, workers .11-.254). Always
// allowlisted so an intra-cluster request is never mistaken for an attacker and
// the cluster can't lock itself (or the panel) out. Mirrors the CIDR in
// nomad-cluster.ts / nomad-mesh.ts.
export const WG_OVERLAY_CIDR = "10.10.0.0/24";

// Accept a bare IPv4/IPv6 address or a CIDR. Deliberately permissive (CrowdSec
// validates for real); this just keeps obviously-bad input out of the config.
const IP_OR_CIDR_RE =
	/^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)(?:\/\d{1,3})?$/;

const normalizeAllowlist = (raw: unknown): string[] => {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const v = typeof item === "string" ? item.trim() : "";
		if (v === "" || !IP_OR_CIDR_RE.test(v) || seen.has(v)) continue;
		seen.add(v);
		out.push(v);
	}
	return out;
};

// Config lives beside the OTel config under the nomploy root
// (BASE_PATH/crowdsec/config.json).
const crowdsecConfigPath = (): string =>
	path.join(paths().MAIN_TRAEFIK_PATH, "..", "crowdsec", "config.json");

/** Read the persisted CrowdSec config, tolerating absence/corruption. */
export const getCrowdsecConfig = (): CrowdsecConfig => {
	try {
		const raw = readFileSync(crowdsecConfigPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<CrowdsecConfig>;
		return {
			enabled: parsed.enabled === true,
			enforce: parsed.enforce === true,
			bouncerKey:
				typeof parsed.bouncerKey === "string" ? parsed.bouncerKey : "",
			allowlist: normalizeAllowlist(parsed.allowlist),
		};
	} catch {
		return { ...DEFAULT_CROWDSEC_CONFIG };
	}
};

/**
 * Validate and persist the CrowdSec config. Generates a bouncer key on first
 * enable (so it's stable across restarts and ready for the bouncer phase).
 * Creates the config dir (mkdir -p) before writing. Returns the normalized
 * config that was written.
 */
export const setCrowdsecConfig = (cfg: CrowdsecConfig): CrowdsecConfig => {
	const enabled = cfg.enabled === true;
	let bouncerKey =
		typeof cfg.bouncerKey === "string" ? cfg.bouncerKey.trim() : "";
	if (enabled && bouncerKey === "") {
		bouncerKey = randomBytes(32).toString("hex");
	}
	const normalized: CrowdsecConfig = {
		enabled,
		enforce: cfg.enforce === true,
		bouncerKey,
		allowlist: normalizeAllowlist(cfg.allowlist),
	};
	const file = crowdsecConfigPath();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(normalized, null, 2), "utf8");
	return normalized;
};

/**
 * CrowdSec acquisition for the hub Traefik access log. One datasource, tailing
 * the (JSON) access log the hub writes; `type: traefik` routes it to the
 * crowdsecurity/traefik parser/scenarios installed via COLLECTIONS.
 */
export const generateCrowdsecAcquis = (): string =>
	`filenames:
  - ${CONTAINER_LOG_DIR}/access.log
labels:
  type: traefik
`;

/**
 * A Nomad `service` job running CrowdSec (LAPI + agent) pinned to the hub. It
 * binds the hub's dynamic dir read-only to tail access.log, persists its data
 * dir on the hub (sqlite DB + downloaded hub items), and renders the Traefik
 * acquisition into the container. Detection-only: no bouncer consumes its
 * decisions yet. Pinned to the control plane because the log it reads is the
 * hub's local file; the data volume therefore always lands on the same node.
 */
export const generateCrowdsecJob = (cfg: CrowdsecConfig): string => {
	const acquis = generateCrowdsecAcquis();
	// Pre-register the Traefik bouncer so a later phase can enforce without
	// re-registering; harmless while no bouncer connects.
	const bouncerEnv = cfg.bouncerKey
		? `\n        BOUNCER_KEY_traefik = "${cfg.bouncerKey}"`
		: "";
	return `job "${JOB_NAME}" {
  datacenters = ["dc1"]
  type        = "service"

  # Pin to the hub (control plane): CrowdSec reads the hub's LOCAL Traefik access
  # log file, so it must run where that file lives. Its data dir (sqlite) is a
  # host bind on the same node for persistence across restarts.
  constraint {
    attribute = "\${meta.nomploy_control_plane}"
    operator  = "="
    value     = "true"
  }

  group "crowdsec" {
    count = 1

    reschedule {
      unlimited      = true
      delay          = "15s"
      delay_function = "constant"
    }

    task "crowdsec" {
      driver = "docker"

      env {
        COLLECTIONS        = "crowdsecurity/traefik"
        DISABLE_ONLINE_API = "true"${bouncerEnv}
      }

      config {
        # Bridge (NOT host) networking: the hub Traefik already owns :8080 on the
        # host (api.insecure dashboard), and CrowdSec's LAPI defaults to :8080 —
        # host networking would collide and the container would crash-loop on
        # bind failure. In bridge mode the LAPI + local agent talk over the
        # container's own localhost; Phase 1 needs no external access to LAPI (a
        # later enforcement phase will publish it for cluster-wide bouncers). The
        # access-log bind mount below is unaffected by the network mode.
        image        = "${CROWDSEC_IMAGE}"
        network_mode = "bridge"
        volumes = [
          "/etc/nomploy/traefik/dynamic:${CONTAINER_LOG_DIR}:ro",
          "/etc/nomploy/crowdsec/data:/var/lib/crowdsec/data",
        ]
        mount {
          type     = "bind"
          source   = "local/acquis-traefik.yaml"
          target   = "/etc/crowdsec/acquis.d/traefik.yaml"
          readonly = true
        }
      }

      template {
        destination = "local/acquis-traefik.yaml"
        change_mode = "restart"
        data        = <<EOH
${acquis}EOH
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
 * Ensure the hub Traefik writes a (JSON) file access log — CrowdSec's only input
 * in Phase 1. Idempotent: if the access log is already configured, it does
 * nothing; otherwise it enables it (mirroring settings.toggleRequests) and
 * recreates the standalone hub Traefik (skipping the image pull) so the static
 * config change takes effect.
 */
export const ensureHubAccessLog = async (): Promise<void> => {
	const mainConfig = readMainConfig();
	if (!mainConfig) return;
	const current = parse(mainConfig) as {
		accessLog?: { filePath?: string };
	};
	if (current?.accessLog?.filePath) return; // already on
	current.accessLog = {
		filePath: HUB_ACCESS_LOG,
		format: "json",
		bufferingSize: 50,
	} as never;
	writeMainConfig(stringify(current));
	// Recreate the hub Traefik so it picks up the new static accessLog config.
	await initializeStandaloneTraefik({ skipPull: true });
};

/**
 * Deploy (or update) the CrowdSec detector on the hub: ensure the access log is
 * on, create the host data/acquis dirs, render the HCL and `nomad job run` it.
 */
export const deployCrowdsec = async (): Promise<void> => {
	const cfg = getCrowdsecConfig();
	await ensureHubAccessLog();
	const hcl = generateCrowdsecJob(cfg);
	const encoded = encodeBase64(hcl);
	const jobFilePath = `/etc/nomploy/jobs/${JOB_NAME}.nomad.hcl`;
	const command = `
set -e
mkdir -p /etc/nomploy/jobs /etc/nomploy/crowdsec/data
echo "${encoded}" | base64 -d > "${jobFilePath}"
if ! nomad job run "${jobFilePath}" 2>&1; then
	echo "Error: CrowdSec job deployment failed"
	exit 1
fi
echo "CrowdSec job deployed"
`;
	await execAsync(command);
};

/** Stop + purge the CrowdSec job (tolerates not-found). */
export const stopCrowdsec = async (): Promise<void> => {
	await execAsync(`nomad job stop -purge ${JOB_NAME} 2>&1 || true`);
};

// ─── Status + decisions (for the Security UI) ────────────────────────────────

const NOMAD_LOCAL = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const nomadHeaders = (): Record<string, string> => {
	const t = process.env.NOMAD_TOKEN || "";
	return t ? { "X-Nomad-Token": t } : {};
};

// Shell-safety: only ever interpolate a Nomad alloc id / IP into a command after
// it matches one of these, so a value that reached us can't inject shell.
const ALLOC_ID_RE = /^[a-f0-9-]{36}$/i;

export type CrowdsecDecision = {
	id: number | null;
	value: string; // the banned IP/range
	scope: string; // "Ip" | "Range" | ...
	type: string; // "ban" | "captcha" | ...
	scenario: string;
	origin: string; // "crowdsec" | "cscli" | "lists:..." | ...
	duration: string; // e.g. "3h59m"
};

export type CrowdsecStatus = {
	deployed: boolean;
	status: string | null;
	runningAllocs: number;
	node: string | null;
	allocId: string | null;
	image: string;
	/** Active decisions from LAPI (null = couldn't read them). */
	decisions: CrowdsecDecision[] | null;
	enforce: boolean;
};

/** Flatten `cscli decisions list -o json` output into a flat decision list. */
const parseDecisions = (raw: string): CrowdsecDecision[] => {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	const toDecision = (d: Record<string, unknown>): CrowdsecDecision => ({
		id: typeof d.id === "number" ? d.id : null,
		value: typeof d.value === "string" ? d.value : "",
		scope: typeof d.scope === "string" ? d.scope : "",
		type: typeof d.type === "string" ? d.type : "",
		scenario: typeof d.scenario === "string" ? d.scenario : "",
		origin: typeof d.origin === "string" ? d.origin : "",
		duration: typeof d.duration === "string" ? d.duration : "",
	});
	const out: CrowdsecDecision[] = [];
	for (const item of data as Record<string, unknown>[]) {
		// `decisions list` returns alerts, each carrying a `decisions` array; older
		// shapes return flat decisions — handle both.
		if (Array.isArray(item?.decisions)) {
			for (const d of item.decisions as Record<string, unknown>[]) {
				if (d?.value) out.push(toDecision(d));
			}
		} else if (item?.value) {
			out.push(toDecision(item));
		}
	}
	return out;
};

/**
 * Current CrowdSec job status plus the active decisions (read with `cscli
 * decisions list` inside the running alloc). Best-effort: decisions is null when
 * the alloc isn't running or the exec fails.
 */
export const getCrowdsecStatus = async (): Promise<CrowdsecStatus> => {
	const cfg = getCrowdsecConfig();
	const out: CrowdsecStatus = {
		deployed: false,
		status: null,
		runningAllocs: 0,
		node: null,
		allocId: null,
		image: CROWDSEC_IMAGE,
		decisions: null,
		enforce: cfg.enforce,
	};
	try {
		const jobRes = await fetch(`${NOMAD_LOCAL}/v1/job/${JOB_NAME}`, {
			headers: nomadHeaders(),
		});
		if (jobRes.ok) {
			const job = (await jobRes.json()) as { Status?: string; Stop?: boolean };
			out.deployed = job.Stop !== true;
			out.status = job.Status ?? null;
			const allocRes = await fetch(
				`${NOMAD_LOCAL}/v1/job/${JOB_NAME}/allocations`,
				{ headers: nomadHeaders() },
			);
			if (allocRes.ok) {
				const allocs = (await allocRes.json()) as {
					ClientStatus?: string;
					NodeName?: string;
					ID?: string;
				}[];
				const running = allocs.filter((a) => a.ClientStatus === "running");
				out.runningAllocs = running.length;
				if (running[0]) {
					out.node = running[0].NodeName ?? null;
					out.allocId = running[0].ID ?? null;
				}
			}
		}
	} catch {
		// leave defaults
	}

	if (out.allocId && ALLOC_ID_RE.test(out.allocId)) {
		try {
			const { stdout } = await execAsync(
				`nomad alloc exec -i=false -t=false -task crowdsec ${out.allocId} cscli decisions list -o json 2>/dev/null`,
			);
			out.decisions = parseDecisions(stdout || "[]");
		} catch {
			out.decisions = null;
		}
	}
	return out;
};

/**
 * Remove all CrowdSec decisions for an IP (operator "unban"). Validates the IP
 * before it reaches the shell. Returns the number of decisions deleted (best
 * effort).
 */
export const crowdsecUnban = async (ip: string): Promise<void> => {
	const value = (ip ?? "").trim();
	if (!IP_OR_CIDR_RE.test(value)) {
		throw new Error("invalid IP/range");
	}
	const status = await getCrowdsecStatus();
	if (!status.allocId || !ALLOC_ID_RE.test(status.allocId)) {
		throw new Error("CrowdSec is not running");
	}
	await execAsync(
		`nomad alloc exec -i=false -t=false -task crowdsec ${status.allocId} cscli decisions delete --ip ${value} 2>&1`,
	);
};

export const CROWDSEC_JOB_NAME = JOB_NAME;
