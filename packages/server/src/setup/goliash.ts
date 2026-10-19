import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths } from "../constants";
import { createNomadToken, deleteNomadToken } from "../services/nomad-acl";
import { execAsync } from "../utils/process/execAsync";

/**
 * One-click Goliash integration. Goliash (the user's own service-×-environment
 * matrix / release-drift dashboard, ghcr.io/pipozzz/goliash) can watch a Nomad
 * cluster read-only and render its jobs as tiles. Wiring it up by hand was
 * painful (mint a Nomad ACL token, set credentials_ref, point DNS at the hub for
 * Consul names, pick SQLite-vs-Postgres, create a metrics auth profile — see the
 * goliash nomad-pack). This panel-owned job does all of that automatically:
 *
 *  - mints a READ-ONLY Nomad token through the control-plane management token and
 *    wires it as GOLIASH_CREDENTIAL_NOMAD + the bootstrap target's credentials_ref;
 *  - pins the job to the hub (control-plane) node so the SQLite volume is stable
 *    across reschedules (the historical cause of the bootstrap-reuse 403 loop) —
 *    unless a Postgres DSN is given, in which case it runs stateless/unpinned;
 *  - points the bootstrap's Nomad address at the control plane (10.10.0.1:4646)
 *    and the container DNS at the hub dnsmasq so *.service.consul resolves;
 *  - emits its own Consul/Traefik router for the public URL's host (web+websecure
 *    + the same letsencrypt certresolver apps use), so it's reachable with TLS;
 *  - optionally tags itself for the built-in OTel Collector's /metrics scrape.
 *
 * Mirrors the activator/otel/crowdsec setup modules: a JSON config on disk, a
 * generated Nomad job, deploy/stop, and leader-boot self-heal.
 */
const JOB_NAME = "nomploy-goliash";
// A real image tag (goliash images are versioned 1.x; 0.11.0 was a pack version,
// not an image tag). Overridable in the UI; pin a newer tag there as they ship.
const DEFAULT_IMAGE = "ghcr.io/pipozzz/goliash:1.20.0";
// Static host port for the web UI / API / agent endpoint (goliash default).
const GOLIASH_PORT = 8070;
// The control-plane Nomad + hub dnsmasq (forwards *.service.consul), over WG.
const HUB_WG_IP = "10.10.0.1";
const NOMAD_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";

export type GoliashConfig = {
	enabled: boolean;
	image: string;
	/** Public address people use, e.g. https://goliash.example.com. Also the Traefik Host. */
	publicUrl: string;
	ownerEmail: string;
	/** Goliash environment name for this cluster, e.g. "prod". */
	environment: string;
	/** Optional Postgres DSN. "" = SQLite on a hub-pinned data volume. */
	databaseUrl: string;
	metricsEnabled: boolean;
	metricsAuthProfile: string;
	/** Minted read-only Nomad token (secret) — auto-wired, never shown in the UI. */
	nomadToken: string;
	/** Accessor of the minted token, so we can revoke it on disable. */
	nomadTokenAccessor: string;
	/** Encrypts goliash notification-channel secrets; generated once. */
	secretKey: string;
};

const DEFAULT_CONFIG: GoliashConfig = {
	enabled: false,
	image: DEFAULT_IMAGE,
	publicUrl: "",
	ownerEmail: "",
	environment: "prod",
	databaseUrl: "",
	metricsEnabled: false,
	metricsAuthProfile: "",
	nomadToken: "",
	nomadTokenAccessor: "",
	secretKey: "",
};

const configPath = (): string =>
	path.join(paths().MAIN_TRAEFIK_PATH, "..", "goliash", "config.json");

export const getGoliashConfig = (): GoliashConfig => {
	try {
		const parsed = JSON.parse(
			readFileSync(configPath(), "utf8"),
		) as Partial<GoliashConfig>;
		return {
			enabled: parsed.enabled === true,
			image:
				typeof parsed.image === "string" && parsed.image
					? parsed.image
					: DEFAULT_IMAGE,
			publicUrl: typeof parsed.publicUrl === "string" ? parsed.publicUrl : "",
			ownerEmail: typeof parsed.ownerEmail === "string" ? parsed.ownerEmail : "",
			environment:
				typeof parsed.environment === "string" && parsed.environment
					? parsed.environment
					: "prod",
			databaseUrl:
				typeof parsed.databaseUrl === "string" ? parsed.databaseUrl : "",
			metricsEnabled: parsed.metricsEnabled === true,
			metricsAuthProfile:
				typeof parsed.metricsAuthProfile === "string"
					? parsed.metricsAuthProfile
					: "",
			nomadToken: typeof parsed.nomadToken === "string" ? parsed.nomadToken : "",
			nomadTokenAccessor:
				typeof parsed.nomadTokenAccessor === "string"
					? parsed.nomadTokenAccessor
					: "",
			secretKey: typeof parsed.secretKey === "string" ? parsed.secretKey : "",
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
};

const writeConfig = (cfg: GoliashConfig): void => {
	const file = configPath();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8");
};

/**
 * Persist the config the UI submitted, provisioning the secrets the integration
 * needs: a read-only Nomad token (minted once via the management token) and a
 * secret key. On disable we revoke the minted token and forget it. The caller
 * then (re)deploys/stops the job via deployGoliash.
 */
export const setGoliashConfig = async (
	input: Omit<GoliashConfig, "nomadToken" | "nomadTokenAccessor" | "secretKey">,
): Promise<GoliashConfig> => {
	const prev = getGoliashConfig();
	let { nomadToken, nomadTokenAccessor, secretKey } = prev;

	if (input.enabled) {
		if (!nomadToken) {
			const minted = await createNomadToken("goliash", "read");
			nomadToken = minted.secretId;
			nomadTokenAccessor = minted.accessorId;
		}
		if (!secretKey) secretKey = randomBytes(32).toString("base64");
	} else {
		// Disabling: revoke the token we minted so it doesn't linger.
		if (nomadTokenAccessor) {
			await deleteNomadToken(nomadTokenAccessor).catch(() => {});
		}
		nomadToken = "";
		nomadTokenAccessor = "";
	}

	const normalized: GoliashConfig = {
		enabled: input.enabled === true,
		image: input.image?.trim() || DEFAULT_IMAGE,
		publicUrl: input.publicUrl?.trim() ?? "",
		ownerEmail: input.ownerEmail?.trim() ?? "",
		environment: input.environment?.trim() || "prod",
		databaseUrl: input.databaseUrl?.trim() ?? "",
		metricsEnabled: input.metricsEnabled === true,
		metricsAuthProfile: input.metricsAuthProfile?.trim() ?? "",
		nomadToken,
		nomadTokenAccessor,
		secretKey,
	};
	writeConfig(normalized);
	return normalized;
};

/** Hostname for the Traefik Host(...) rule, parsed from the public URL. */
const hostOf = (publicUrl: string): string => {
	try {
		return new URL(publicUrl).hostname;
	} catch {
		return publicUrl.replace(/^https?:\/\//, "").split("/")[0] ?? "";
	}
};

/**
 * The Nomad job (single host-networked alloc) running goliash with everything
 * wired. Pinned to the hub when on SQLite so the data volume is stable.
 */
export const generateGoliashJob = (cfg: GoliashConfig): string => {
	const usePostgres = cfg.databaseUrl !== "";
	const host = hostOf(cfg.publicUrl);
	const pushSubject = cfg.ownerEmail
		? `mailto:${cfg.ownerEmail}`
		: "mailto:admin@example.com";

	// Consul/Traefik router tags for the public host (same scheme apps use), plus
	// optional metrics-scrape tags. Only emitted when a public URL is configured.
	const routerTags: string[] = [];
	if (host) {
		routerTags.push(
			`"traefik.enable=true"`,
			`"traefik.http.routers.goliash-web.rule=Host(\`${host}\`)"`,
			`"traefik.http.routers.goliash-web.entrypoints=web"`,
			`"traefik.http.routers.goliash-secure.rule=Host(\`${host}\`)"`,
			`"traefik.http.routers.goliash-secure.entrypoints=websecure"`,
			`"traefik.http.routers.goliash-secure.tls.certresolver=letsencrypt"`,
		);
	}
	if (cfg.metricsEnabled) {
		routerTags.push(`"nomploy.metrics.port=${GOLIASH_PORT}"`);
		if (cfg.metricsAuthProfile)
			routerTags.push(`"nomploy.metrics.auth=${cfg.metricsAuthProfile}"`);
	}
	const tagsBlock =
		routerTags.length > 0
			? `\n      tags = [\n        ${routerTags.join(",\n        ")},\n      ]`
			: "";

	// SQLite → pin to the control-plane node so the named volume is stable across
	// reschedules (a bouncing alloc reusing a stale per-node SQLite was the old
	// bootstrap-reuse 403 loop). Postgres is stateless → no pin, no volume.
	const pinConstraint = usePostgres
		? ""
		: `
  constraint {
    attribute = "\${meta.nomploy_control_plane}"
    value     = "true"
  }
`;
	const volumeMount = usePostgres
		? ""
		: `
        mount {
          type   = "volume"
          target = "/data"
          source = "nomploy_goliash_data"
        }`;

	const envLines = [
		`        GOLIASH_LISTEN         = ":${GOLIASH_PORT}"`,
		`        GOLIASH_BOOTSTRAP_FILE = "/local/bootstrap.yaml"`,
		usePostgres ? `        GOLIASH_DATABASE_URL   = "${cfg.databaseUrl}"` : "",
		cfg.publicUrl
			? `        GOLIASH_PUBLIC_URL     = "${cfg.publicUrl}"`
			: `        GOLIASH_PUBLIC_URL     = "http://\${attr.unique.network.ip-address}:${GOLIASH_PORT}"`,
		`        GOLIASH_PUSH_SUBJECT   = "${pushSubject}"`,
		cfg.secretKey ? `        GOLIASH_SECRET_KEY     = "${cfg.secretKey}"` : "",
		cfg.nomadToken
			? `        GOLIASH_CREDENTIAL_NOMAD = "${cfg.nomadToken}"`
			: "",
	]
		.filter(Boolean)
		.join("\n");

	// Bootstrap: one environment + a read-only Nomad target pointed at the control
	// plane, with credentials_ref mapping to GOLIASH_CREDENTIAL_NOMAD. Written on
	// first start only — later UI edits in goliash are preserved.
	const bootstrap = `owner: "${cfg.ownerEmail || "admin@example.com"}"
environments:
  - name: "${cfg.environment}"
    position: 30
targets:
  - name: "${cfg.environment}-nomad"
    environment: "${cfg.environment}"
    platform: nomad
    poll_interval_seconds: 60
    settings:
${cfg.nomadToken ? "      credentials_ref: nomad\n" : ""}      nomad:
        address: "http://${HUB_WG_IP}:4646"
`;

	return `job "${JOB_NAME}" {
  datacenters = ["dc1"]
  type        = "service"
${pinConstraint}
  group "goliash" {
    count = 1

    network {
      mode = "host"
      dns {
        servers = ["${HUB_WG_IP}"]
      }
      port "http" {
        static = ${GOLIASH_PORT}
      }
    }

    service {
      name     = "${JOB_NAME}"
      port     = "http"
      provider = "consul"${tagsBlock}

      check {
        type     = "http"
        path     = "/healthz"
        interval = "30s"
        timeout  = "5s"
      }
    }

    restart {
      attempts = 3
      interval = "5m"
      delay    = "15s"
      mode     = "delay"
    }

    task "goliash" {
      driver = "docker"

      config {
        image        = "${cfg.image}"
        network_mode = "host"
        args         = ["serve"]${volumeMount}
      }

      env {
${envLines}
      }

      template {
        destination = "local/bootstrap.yaml"
        change_mode = "noop"
        data        = <<EOH
${bootstrap}EOH
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

const nomadHeaders = (): Record<string, string> =>
	process.env.NOMAD_TOKEN ? { "X-Nomad-Token": process.env.NOMAD_TOKEN } : {};

/** Deploy or stop goliash to match the config. */
export const deployGoliash = async (): Promise<void> => {
	const cfg = getGoliashConfig();
	if (!cfg.enabled) {
		await stopGoliash();
		return;
	}
	const spec = generateGoliashJob(cfg);
	const file = path.join(
		paths().MAIN_TRAEFIK_PATH,
		"..",
		"goliash",
		"job.nomad.hcl",
	);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, spec, "utf8");
	await execAsync(`nomad job run "${file}"`);
};

export const stopGoliash = async (): Promise<void> => {
	try {
		await fetch(
			`${NOMAD_ADDRESS.replace(/\/$/, "")}/v1/job/${JOB_NAME}?purge=true`,
			{ method: "DELETE", headers: nomadHeaders() },
		);
	} catch {
		// best-effort — Nomad unreachable; reconciled on the next leader boot
	}
};
