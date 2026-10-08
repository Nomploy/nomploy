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

export type OtelConfig = {
	enabled: boolean;
	otlpEndpoint: string;
	otlpHeaders: Record<string, string>;
	scrapeIntervalSeconds: number;
};

const DEFAULT_OTEL_CONFIG: OtelConfig = {
	enabled: false,
	otlpEndpoint: "",
	otlpHeaders: {},
	scrapeIntervalSeconds: 30,
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
 *  - `consul-services` — every Consul service, kept only when it carries a
 *    `nomploy.metrics.port=<port>` tag; the port is extracted from the tag and
 *    becomes the scrape target `<service-address>:<port>`.
 *
 * Metrics flow prometheus receiver -> otlp exporter to the configured backend.
 */
export const generateOtelCollectorConfig = (cfg: OtelConfig): string => {
	const token = consulToken();
	// Nested as a sibling of `server:` under the consul_sd_configs list item
	// (14-space indent).
	const tokenLine = token ? `\n              token: ${yamlQuote(token)}` : "";
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
              replacement: "\${1}:8082"
            - target_label: __metrics_path__
              replacement: /metrics
        - job_name: consul-services
          consul_sd_configs:
            - server: ${yamlQuote(CONSUL_SD_SERVER)}${tokenLine}
          relabel_configs:
            # Keep only services tagged nomploy.metrics.port=<port>.
            - source_labels: [__meta_consul_tags]
              regex: .*,nomploy\\.metrics\\.port=([0-9]+),.*
              action: keep
            # Extract the port from that tag and build <service-address>:<port>.
            - source_labels:
                [__meta_consul_service_address, __meta_consul_tags]
              regex: ([^;]+);.*,nomploy\\.metrics\\.port=([0-9]+),.*
              target_label: __address__
              replacement: "\${1}:\${2}"
              separator: ";"
            - target_label: __metrics_path__
              replacement: /metrics
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
      attempts  = 0
      unlimited = true
      delay     = "15s"
      mode      = "delay"
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
