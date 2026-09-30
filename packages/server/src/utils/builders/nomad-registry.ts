import type { domains as domainsTable } from "../../db/schema";
import { generateConsulTags } from "./nomad";

type Domain = typeof domainsTable.$inferSelect;

// Matches the zot the cluster already runs for nomad-packs; pinned, amd64 (the
// whole fleet is amd64 — see [[nomploy-release-pipeline]]).
export const ZOT_IMAGE = "ghcr.io/project-zot/zot-linux-amd64:v2.1.5";
export const ZOT_PORT = 5000;

export interface ZotS3Config {
	endpoint: string; // e.g. https://<acct>.r2.cloudflarestorage.com
	region: string; // R2: "auto"
	bucket: string;
	rootDirectory: string; // key prefix inside the bucket, e.g. "/zot"
}

export interface ZotRegistryJobOptions {
	appName: string; // Nomad job id == the Nomad Variable path nomad/jobs/<appName>
	domain: string; // registry.spertulo.sk
	s3: ZotS3Config; // non-secret S3 params; creds come from the Nomad Variable
	certResolver: string; // "letsencrypt-dns" behind the HA pool, else "letsencrypt"
	deployedAt: string; // ISO stamp → forces a fresh alloc on every apply
}

// A consul-template reference to a key in the job's Nomad Variable. Backtick-quote
// the path so JSON.stringify (below) doesn't escape the quotes and break the
// template expression once it's embedded in config.json.
const varRef = (appName: string, key: string): string =>
	`{{ with nomadVar \`nomad/jobs/${appName}\` }}{{ .${key}.Value }}{{ end }}`;

/**
 * zot's config.json for an S3-backed, htpasswd-protected registry, rendered as a
 * consul-template so the S3 credentials come from the job's Nomad Variable at
 * render time and never appear in the job spec. Also enables the built-in web UI +
 * search (browse images at the domain) and a retention/GC policy.
 *
 * The S3 driver is the docker/distribution one; R2/MinIO need path-style
 * addressing and an absolute rootdirectory.
 */
export const generateZotConfig = (appName: string, s3: ZotS3Config): string =>
	JSON.stringify(
		{
			distSpecVersion: "1.1.1",
			storage: {
				rootDirectory: "/tmp/zot",
				// dedupe needs a remote cache DB (DynamoDB) with remote (S3) storage;
				// we don't run one, so turn it off (zot otherwise refuses to start).
				dedupe: false,
				// Garbage-collect blobs left unreferenced by the retention policy.
				gc: true,
				gcDelay: "1h",
				gcInterval: "24h",
				retention: {
					// Keep the 20 most-recently-pushed tags per repo and drop untagged
					// manifests. Sensible default; tune per deployment later.
					policies: [
						{
							repositories: ["**"],
							deleteUntagged: true,
							keepTags: [{ mostRecentlyPushedCount: 20 }],
						},
					],
				},
				storageDriver: {
					name: "s3",
					// Absolute key prefix (the driver errors on a relative "invalid path").
					rootdirectory: s3.rootDirectory.startsWith("/")
						? s3.rootDirectory
						: `/${s3.rootDirectory}`,
					region: s3.region,
					regionendpoint: s3.endpoint,
					bucket: s3.bucket,
					accesskey: varRef(appName, "s3_accesskey"),
					secretkey: varRef(appName, "s3_secretkey"),
					secure: true,
					forcepathstyle: true,
				},
			},
			http: {
				address: "0.0.0.0",
				port: String(ZOT_PORT),
				auth: { htpasswd: { path: "/etc/zot/htpasswd" } },
			},
			// The web UI + search extension: browse repositories/tags at the domain.
			extensions: {
				search: { enable: true },
				ui: { enable: true },
			},
			log: { level: "info" },
		},
		null,
		2,
	);

/**
 * A Nomad job running zot as nomploy's container registry: S3-backed (stateless,
 * so it reschedules freely), htpasswd-protected, exposed through the existing
 * Traefik/consulCatalog ingress on `domain` with TLS — so cluster nodes pull over
 * a valid cert with no per-node `insecure-registries` daemon config.
 *
 * Secrets (S3 creds + htpasswd) are NOT in this spec: they live in the job's Nomad
 * Variable (nomad/jobs/<appName>) and are pulled in at render time via consul-
 * template (the task's workload identity can read its own job variable). The
 * caller must PUT that variable (keys s3_accesskey, s3_secretkey, htpasswd) before
 * running the job.
 */
export const generateZotRegistryJob = (opts: ZotRegistryJobOptions): string => {
	const { appName, domain, s3, certResolver, deployedAt } = opts;
	const domainObj = {
		host: domain,
		https: true,
		path: "/",
		uniqueConfigKey: 1,
		customCertResolver: certResolver,
	} as unknown as Domain;
	const tags = generateConsulTags(appName, "registry", [domainObj])
		.map((t) => `        "${t.replace(/"/g, '\\"')}",`)
		.join("\n");
	const config = generateZotConfig(appName, s3);
	const htpasswdRef = varRef(appName, "htpasswd");

	return `job "${appName}" {
  datacenters = ["*"]
  type        = "service"

  meta {
    deployed_at = "${deployedAt}"
  }

  group "registry" {
    count = 1

    network {
      port "http" {
        to = ${ZOT_PORT}
      }
    }

    restart {
      attempts = 3
      interval = "5m"
      delay    = "15s"
      mode     = "delay"
    }

    service {
      name     = "${appName}"
      port     = "http"
      provider = "consul"
      tags = [
        "traefik.enable=true",
${tags}
      ]

      check {
        type     = "tcp"
        port     = "http"
        interval = "20s"
        timeout  = "5s"
      }
    }

    task "zot" {
      driver = "docker"

      config {
        image   = "${ZOT_IMAGE}"
        ports   = ["http"]
        args    = ["serve", "/etc/zot/config.json"]
        volumes = [
          "local/config.json:/etc/zot/config.json",
          "local/htpasswd:/etc/zot/htpasswd",
        ]
      }

      template {
        destination = "local/config.json"
        change_mode = "restart"
        data        = <<EOZOT
${config}
EOZOT
      }

      template {
        destination = "local/htpasswd"
        change_mode = "restart"
        data        = <<EOHTP
${htpasswdRef}
EOHTP
      }

      resources {
        cpu    = 300
        memory = 256
      }
    }
  }
}
`;
};
