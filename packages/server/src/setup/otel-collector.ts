import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths } from "../constants";
import { encodeBase64 } from "../utils/docker/utils";
import { execAsync } from "../utils/process/execAsync";

const JOB_NAME = "nomploy-otel-collector";
// The hub, where Consul runs; reachable cluster-wide over WireGuard. Mirrors
// HUB_DNS_IP in loadbalancer-dns.ts. The OTel Collector runs as a single
// (reschedulable) job on some node, so it talks to the hub's Consul over the
// mesh rather than a node-local 127.0.0.1:8500.
const CONSUL_SD_SERVER = "10.10.0.1:8500";
// Pinned recent otel-collector-contrib release (contrib has the prometheus
// receiver + consul_sd discovery + otlp exporter we rely on).
const OTEL_IMAGE = "otel/opentelemetry-collector-contrib:0.111.0";

const consulToken = (): string => process.env.CONSUL_TOKEN ?? "";

/**
 * Credential the collector presents when scraping discovered services whose
 * /metrics is behind auth. The Prometheus receiver attaches one credential per
 * scrape job, so this is a single cluster-wide credential applied to the
 * tag-discovered services job; the Traefik :8082 endpoint is always scraped
 * unauthenticated.
 *  - `none`   — no scrape auth.
 *  - `bearer` — `Authorization: <scheme> <credentials>`. `scheme` defaults to
 *               "Bearer" but can be any scheme word (e.g. "Token"), so a range
 *               of header-token schemes are covered.
 *  - `basic`  — HTTP Basic (`username`/`password`).
 */
export type OtelScrapeAuth =
	| { type: "none" }
	| { type: "bearer"; scheme: string; credentials: string }
	| { type: "basic"; username: string; password: string };

/**
 * A named scrape credential. A service opts into one by carrying the Consul tag
 * `nomploy.metrics.auth=<name>` (alongside `nomploy.metrics.port=<port>`); the
 * collector emits a dedicated scrape job per profile that presents this
 * credential. Prometheus attaches auth per scrape job (not per target — see the
 * receiver docs), so per-service tokens are modelled as one job per profile, and
 * the token value lives here (central, rotatable) rather than in Consul. `name`
 * must match PROFILE_NAME_RE so it is safe in a job name and a tag regex.
 */
export type OtelAuthProfile = { name: string } & (
	| { type: "bearer"; scheme: string; credentials: string }
	| { type: "basic"; username: string; password: string }
);

// Profile names key the tag (`nomploy.metrics.auth=<name>`), a scrape job name,
// and a regex, so keep them to an unambiguous, regex-safe charset.
export const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

export type OtelConfig = {
	enabled: boolean;
	otlpEndpoint: string;
	otlpHeaders: Record<string, string>;
	scrapeIntervalSeconds: number;
	/** Default credential for tagged services that name no auth profile. */
	scrapeAuth: OtelScrapeAuth;
	/** Named credentials a service selects via `nomploy.metrics.auth=<name>`. */
	authProfiles: OtelAuthProfile[];
};

const DEFAULT_OTEL_CONFIG: OtelConfig = {
	enabled: false,
	otlpEndpoint: "",
	otlpHeaders: {},
	scrapeIntervalSeconds: 30,
	scrapeAuth: { type: "none" },
	authProfiles: [],
};

/**
 * Normalize an arbitrary value into a well-formed, deduped profile list: valid
 * names only (PROFILE_NAME_RE), each with a usable bearer/basic credential,
 * first occurrence of a name winning.
 */
const normalizeAuthProfiles = (raw: unknown): OtelAuthProfile[] => {
	if (!Array.isArray(raw)) return [];
	const out: OtelAuthProfile[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const p = item as Partial<Record<string, unknown>>;
		const name = typeof p?.name === "string" ? p.name.trim() : "";
		if (!PROFILE_NAME_RE.test(name) || seen.has(name)) continue;
		const auth = normalizeScrapeAuth(p);
		if (auth.type === "none") continue; // a profile must carry a credential
		seen.add(name);
		out.push({ name, ...auth } as OtelAuthProfile);
	}
	return out;
};

/**
 * Normalize an arbitrary persisted/input value into a well-formed scrape-auth.
 * Also migrates the legacy `scrapeBearerToken` string (shipped in v0.30.198)
 * into a `bearer` auth so an upgrade keeps working.
 */
const normalizeScrapeAuth = (
	raw: unknown,
	legacyBearer?: unknown,
): OtelScrapeAuth => {
	const a = raw as Partial<Record<string, unknown>> | undefined;
	const type = a?.type;
	if (type === "bearer") {
		const credentials =
			typeof a?.credentials === "string" ? a.credentials.trim() : "";
		const scheme =
			typeof a?.scheme === "string" && a.scheme.trim() !== ""
				? a.scheme.trim()
				: "Bearer";
		return credentials === ""
			? { type: "none" }
			: { type: "bearer", scheme, credentials };
	}
	if (type === "basic") {
		const username = typeof a?.username === "string" ? a.username.trim() : "";
		const password = typeof a?.password === "string" ? a.password : "";
		return username === "" && password === ""
			? { type: "none" }
			: { type: "basic", username, password };
	}
	// Legacy migration: a bare scrapeBearerToken string.
	if (typeof legacyBearer === "string" && legacyBearer.trim() !== "") {
		return {
			type: "bearer",
			scheme: "Bearer",
			credentials: legacyBearer.trim(),
		};
	}
	return { type: "none" };
};

// The observability config lives in a sibling dir of the main Traefik config,
// under the nomploy config root (BASE_PATH/otel/config.json).
const otelConfigPath = (): string =>
	path.join(paths().MAIN_TRAEFIK_PATH, "..", "otel", "config.json");

/**
 * Read the persisted OTel Collector config. Returns the defaults
 * (`enabled:false`, empty endpoint, 30s interval) when the file is absent or
 * malformed, so callers always get a well-formed config.
 */
export const getOtelConfig = (): OtelConfig => {
	try {
		const raw = readFileSync(otelConfigPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<OtelConfig>;
		const scrape = Number(parsed.scrapeIntervalSeconds);
		return {
			enabled: parsed.enabled === true,
			otlpEndpoint:
				typeof parsed.otlpEndpoint === "string" ? parsed.otlpEndpoint : "",
			otlpHeaders:
				parsed.otlpHeaders && typeof parsed.otlpHeaders === "object"
					? (parsed.otlpHeaders as Record<string, string>)
					: {},
			scrapeIntervalSeconds:
				Number.isFinite(scrape) && scrape >= 5 && scrape <= 3600
					? Math.floor(scrape)
					: DEFAULT_OTEL_CONFIG.scrapeIntervalSeconds,
			scrapeAuth: normalizeScrapeAuth(
				(parsed as { scrapeAuth?: unknown }).scrapeAuth,
				(parsed as { scrapeBearerToken?: unknown }).scrapeBearerToken,
			),
			authProfiles: normalizeAuthProfiles(
				(parsed as { authProfiles?: unknown }).authProfiles,
			),
		};
	} catch {
		return { ...DEFAULT_OTEL_CONFIG };
	}
};

/**
 * Validate and persist the OTel Collector config. Throws on an out-of-range
 * scrape interval, or an empty endpoint while enabled. Creates the config dir
 * (mkdir -p) before writing.
 */
export const setOtelConfig = (cfg: OtelConfig): void => {
	const scrape = Math.floor(Number(cfg.scrapeIntervalSeconds));
	if (!Number.isFinite(scrape) || scrape < 5 || scrape > 3600) {
		throw new Error("scrapeIntervalSeconds must be between 5 and 3600 seconds");
	}
	const endpoint = (cfg.otlpEndpoint ?? "").trim();
	if (cfg.enabled && endpoint === "") {
		throw new Error("otlpEndpoint is required when observability is enabled");
	}
	const normalized: OtelConfig = {
		enabled: cfg.enabled === true,
		otlpEndpoint: endpoint,
		otlpHeaders:
			cfg.otlpHeaders && typeof cfg.otlpHeaders === "object"
				? cfg.otlpHeaders
				: {},
		scrapeIntervalSeconds: scrape,
		scrapeAuth: normalizeScrapeAuth(cfg.scrapeAuth),
		authProfiles: normalizeAuthProfiles(cfg.authProfiles),
	};
	const file = otelConfigPath();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(normalized, null, 2), "utf8");
};

const yamlQuote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`;

/**
 * Render the OTel Collector YAML config for the given settings.
 *
 * Two Prometheus scrape jobs, both discovered from the hub's Consul:
 *  - `traefik` — the HA LB pool's host-networked Traefik, scraped on :8082
 *    (its Prometheus metrics entryPoint). The Consul service address is the
 *    node IP.
 *  - `consul-services` — services tagged `nomploy.metrics.port=<port>` that name
 *    no auth profile; the port is extracted and the target becomes
 *    `<service-address>:<port>`. Scraped with the default credential.
 *  - `consul-services-<profile>` — one per auth profile: the same, but only
 *    services also tagged `nomploy.metrics.auth=<profile>`, scraped with that
 *    profile's credential (Prometheus auth is per job, not per target).
 *
 * Metrics flow prometheus receiver -> otlp exporter to the configured backend.
 */
export const generateOtelCollectorConfig = (cfg: OtelConfig): string => {
	const token = consulToken();
	// Nested as a sibling of `server:` under the consul_sd_configs list item
	// (14-space indent).
	const tokenLine = token ? `\n              token: ${yamlQuote(token)}` : "";
	// Scrape credential as a scrape_config-level block (10-space indent), sibling
	// of `consul_sd_configs:`/`relabel_configs:`. Prometheus auth is per-job, so
	// per-service tokens are modelled as one job per auth profile below.
	const authToBlock = (auth: OtelScrapeAuth): string => {
		if (auth.type === "bearer") {
			return `\n          authorization:\n            type: ${yamlQuote(auth.scheme || "Bearer")}\n            credentials: ${yamlQuote(auth.credentials)}`;
		}
		if (auth.type === "basic") {
			return `\n          basic_auth:\n            username: ${yamlQuote(auth.username)}\n            password: ${yamlQuote(auth.password)}`;
		}
		return "";
	};
	// One consul-services scrape job. `authTagRelabel` narrows which tagged
	// services this job owns (the default job drops any that name a profile; a
	// profile job keeps only those naming it), so each service is scraped by
	// exactly one job with the right credential.
	const servicesJob = (
		jobName: string,
		authBlock: string,
		authTagRelabel: string,
	): string => `        - job_name: ${jobName}${authBlock}
          consul_sd_configs:
            - server: ${yamlQuote(CONSUL_SD_SERVER)}${tokenLine}
          relabel_configs:
            # Keep only services tagged nomploy.metrics.port=<port>.
            - source_labels: [__meta_consul_tags]
              regex: .*,nomploy\\.metrics\\.port=([0-9]+),.*
              action: keep${authTagRelabel}
            # Extract the port from that tag and build <service-address>:<port>.
            - source_labels:
                [__meta_consul_service_address, __meta_consul_tags]
              regex: ([^;]+);.*,nomploy\\.metrics\\.port=([0-9]+),.*
              target_label: __address__
              # Brace-less capture refs ($1,$2) on purpose: this YAML is embedded
              # in a Nomad HCL2 heredoc, which would interpolate \${1}/\${2} itself
              # (→ "1"/"2") before the collector sees them. $1/$2 pass through.
              replacement: "$1:$2"
              separator: ";"
            - target_label: __metrics_path__
              replacement: /metrics`;

	// Default job: tagged services that name NO auth profile (dropped otherwise,
	// since a per-profile job owns them). Uses the default scrape credential.
	const defaultServicesJob = servicesJob(
		"consul-services",
		authToBlock(cfg.scrapeAuth),
		"\n            # Exclude services that select an auth profile (a per-profile\n            # job scrapes those with their own credential).\n            - source_labels: [__meta_consul_tags]\n              regex: .*,nomploy\\.metrics\\.auth=.*\n              action: drop",
	);
	// One job per profile: tagged services selecting it, scraped with its
	// credential. Profile names are PROFILE_NAME_RE, so safe in job name + regex.
	const profileJobs = cfg.authProfiles
		.map((p) =>
			servicesJob(
				`consul-services-${p.name}`,
				authToBlock(p),
				`\n            # Keep only services selecting the "${p.name}" auth profile.\n            - source_labels: [__meta_consul_tags]\n              regex: .*,nomploy\\.metrics\\.auth=${p.name},.*\n              action: keep`,
			),
		)
		.join("\n");
	const servicesJobsBlock = profileJobs
		? `${defaultServicesJob}\n${profileJobs}`
		: defaultServicesJob;
	const isHttps = /^https:\/\//i.test(cfg.otlpEndpoint.trim());
	const headerEntries = Object.entries(cfg.otlpHeaders ?? {});
	const headersBlock =
		headerEntries.length > 0
			? `\n    headers:\n${headerEntries
					.map(([k, v]) => `      ${yamlQuote(k)}: ${yamlQuote(v)}`)
					.join("\n")}`
			: "\n    headers: {}";

	return `receivers:
  prometheus:
    config:
      global:
        scrape_interval: ${cfg.scrapeIntervalSeconds}s
      scrape_configs:
        - job_name: traefik
          consul_sd_configs:
            - server: ${yamlQuote(CONSUL_SD_SERVER)}${tokenLine}
          relabel_configs:
            # Keep only the Traefik service instances.
            - source_labels: [__meta_consul_service]
              regex: (.*traefik.*)
              action: keep
            # Traefik is host-networked; the Consul service address is the node
            # IP. Scrape its Prometheus metrics entryPoint on :8082.
            - source_labels: [__meta_consul_service_address]
              target_label: __address__
              replacement: "$1:8082"
            - target_label: __metrics_path__
              replacement: /metrics
${servicesJobsBlock}
exporters:
  otlp:
    endpoint: ${yamlQuote(cfg.otlpEndpoint)}${headersBlock}
    tls:
      insecure: ${isHttps ? "false" : "true"}
service:
  pipelines:
    metrics:
      receivers: [prometheus]
      exporters: [otlp]
`;
};

/**
 * A Nomad `service` job running a single OTel Collector that scrapes the
 * cluster's Prometheus metrics (via Consul discovery) and ships them to the
 * configured OTLP backend. The `reschedule` stanza makes it move to another
 * node unlimited times with a fixed delay, so a node death doesn't lose it.
 */
export const generateOtelCollectorJob = (cfg: OtelConfig): string => {
	const configYaml = generateOtelCollectorConfig(cfg);
	return `job "${JOB_NAME}" {
  datacenters = ["dc1"]
  type        = "service"

  group "otel" {
    count = 1

    reschedule {
      unlimited      = true
      delay          = "15s"
      delay_function = "constant"
    }

    network {
      mode = "host"
    }

    task "otel" {
      driver = "docker"

      config {
        image        = "${OTEL_IMAGE}"
        network_mode = "host"
        args         = ["--config=/local/config.yaml"]
      }

      template {
        destination = "local/config.yaml"
        change_mode = "restart"
        data        = <<EOH
${configYaml}EOH
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
 * Deploy (or update) the OTel Collector job on the control plane: render the HCL
 * from the persisted config, write it, and `nomad job run` it. Mirrors
 * deployTraefikHaSystemJob.
 */
export const deployOtelCollector = async (): Promise<void> => {
	const hcl = generateOtelCollectorJob(getOtelConfig());
	const encoded = encodeBase64(hcl);
	const jobFilePath = `/etc/nomploy/jobs/${JOB_NAME}.nomad.hcl`;
	const command = `
set -e
mkdir -p /etc/nomploy/jobs
echo "${encoded}" | base64 -d > "${jobFilePath}"
if ! nomad job run "${jobFilePath}" 2>&1; then
	echo "Error: OTel Collector job deployment failed"
	exit 1
fi
echo "OTel Collector job deployed"
`;
	await execAsync(command);
};

/** Stop + purge the OTel Collector job (tolerates not-found). */
export const stopOtelCollector = async (): Promise<void> => {
	await execAsync(`nomad job stop -purge ${JOB_NAME} 2>&1 || true`);
};

export const OTEL_COLLECTOR_JOB_NAME = JOB_NAME;

// Control-plane-local Nomad/Consul (the panel runs on the hub). Mirrors the
// addresses other setup modules use (pack-domains.ts, resolve.ts).
const NOMAD_LOCAL = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const CONSUL_LOCAL = "http://127.0.0.1:8500";

const nomadHeaders = (): Record<string, string> => {
	const t = process.env.NOMAD_TOKEN || "";
	return t ? { "X-Nomad-Token": t } : {};
};
const consulHeaders = (): Record<string, string> => {
	const t = consulToken();
	return t ? { "X-Consul-Token": t } : {};
};

/** A service the collector discovers and scrapes, derived from Consul tags. */
export type ObservabilityTarget = {
	service: string;
	address: string;
	/** Port from the `nomploy.metrics.port=` tag (interpolated by Nomad). */
	port: number;
	/** `nomploy.metrics.auth=` profile, or null for the default (no-auth) job. */
	authProfile: string | null;
};

export type ObservabilityStatus = {
	collector: {
		deployed: boolean;
		status: string | null;
		runningAllocs: number;
		/** Node the running alloc is on, and its id (for logs). */
		node: string | null;
		allocId: string | null;
		image: string;
	};
	targets: ObservabilityTarget[];
};

const METRICS_PORT_TAG = "nomploy.metrics.port=";
const METRICS_AUTH_TAG = "nomploy.metrics.auth=";

/**
 * Live view for the Observability UI: the collector job's state plus every
 * service the collector would scrape (discovered from Consul by the
 * `nomploy.metrics.port=` tag), with the port and auth profile each resolves to.
 * Best-effort — returns empty/false sections rather than throwing when Nomad or
 * Consul is unreachable.
 */
export const getObservabilityStatus =
	async (): Promise<ObservabilityStatus> => {
		const collector = {
			deployed: false,
			status: null as string | null,
			runningAllocs: 0,
			node: null as string | null,
			allocId: null as string | null,
			image: OTEL_IMAGE,
		};
		try {
			const jobRes = await fetch(`${NOMAD_LOCAL}/v1/job/${JOB_NAME}`, {
				headers: nomadHeaders(),
			});
			if (jobRes.ok) {
				const job = (await jobRes.json()) as {
					Status?: string;
					Stop?: boolean;
				};
				collector.deployed = job.Stop !== true;
				collector.status = job.Status ?? null;
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
					collector.runningAllocs = running.length;
					if (running[0]) {
						collector.node = running[0].NodeName ?? null;
						collector.allocId = running[0].ID ?? null;
					}
				}
			}
		} catch {
			// leave defaults
		}

		const targets: ObservabilityTarget[] = [];
		try {
			const svcRes = await fetch(`${CONSUL_LOCAL}/v1/catalog/services`, {
				headers: consulHeaders(),
			});
			if (svcRes.ok) {
				const services = (await svcRes.json()) as Record<string, string[]>;
				const metricsServices = Object.entries(services)
					.filter(([, tags]) =>
						(tags ?? []).some((t) => t.startsWith(METRICS_PORT_TAG)),
					)
					.map(([name]) => name);
				for (const name of metricsServices) {
					try {
						const instRes = await fetch(
							`${CONSUL_LOCAL}/v1/catalog/service/${encodeURIComponent(name)}`,
							{ headers: consulHeaders() },
						);
						if (!instRes.ok) continue;
						const insts = (await instRes.json()) as {
							ServiceAddress?: string;
							Address?: string;
							ServiceTags?: string[];
						}[];
						for (const s of insts) {
							const tags = s.ServiceTags ?? [];
							const portTag = tags.find((t) => t.startsWith(METRICS_PORT_TAG));
							if (!portTag) continue;
							const port = Number.parseInt(
								portTag.slice(METRICS_PORT_TAG.length),
								10,
							);
							const authTag = tags.find((t) => t.startsWith(METRICS_AUTH_TAG));
							targets.push({
								service: name,
								address: s.ServiceAddress || s.Address || "",
								port: Number.isFinite(port) ? port : 0,
								authProfile: authTag
									? authTag.slice(METRICS_AUTH_TAG.length)
									: null,
							});
						}
					} catch {
						// skip this service
					}
				}
			}
		} catch {
			// leave targets empty
		}

		return { collector, targets };
	};

/**
 * Tail the running collector's logs (combined stderr+stdout) for the
 * Observability UI. Returns the alloc's recent output, or a short message when
 * no alloc is running. Best-effort — never throws.
 */
export const getObservabilityLogs = async (
	lines = 200,
): Promise<{ allocId: string | null; logs: string }> => {
	try {
		const allocRes = await fetch(
			`${NOMAD_LOCAL}/v1/job/${JOB_NAME}/allocations`,
			{ headers: nomadHeaders() },
		);
		if (!allocRes.ok) {
			return { allocId: null, logs: "" };
		}
		const allocs = (await allocRes.json()) as {
			ClientStatus?: string;
			ID?: string;
		}[];
		const alloc = allocs.find((a) => a.ClientStatus === "running");
		if (!alloc?.ID) {
			return { allocId: null, logs: "Collector is not running." };
		}
		// Grab a generous tail from each stream, then merge and keep the last N
		// lines. The collector logs to stderr; stdout is usually empty.
		const fetchStream = async (type: "stderr" | "stdout"): Promise<string> => {
			try {
				const res = await fetch(
					`${NOMAD_LOCAL}/v1/client/fs/logs/${alloc.ID}?task=otel&type=${type}&plain=true&origin=end&offset=60000`,
					{ headers: nomadHeaders() },
				);
				return res.ok ? await res.text() : "";
			} catch {
				return "";
			}
		};
		const [err, out] = await Promise.all([
			fetchStream("stderr"),
			fetchStream("stdout"),
		]);
		const merged = `${out}\n${err}`
			.split("\n")
			.filter((l) => l.trim() !== "")
			.slice(-lines)
			.join("\n");
		return { allocId: alloc.ID, logs: merged || "(no output yet)" };
	} catch {
		return { allocId: null, logs: "" };
	}
};
