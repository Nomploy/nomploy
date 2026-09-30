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
	accessKey: string;
	secretKey: string;
	rootDirectory: string; // key prefix inside the bucket, e.g. "registry"
}

export interface ZotRegistryJobOptions {
	appName: string; // Nomad job id, e.g. "nomploy-registry"
	domain: string; // registry.spertulo.sk
	htpasswd: string; // one "user:$2b$…" line
	s3: ZotS3Config;
	certResolver: string; // "letsencrypt-dns" behind the HA pool, else "letsencrypt"
	deployedAt: string; // ISO stamp → forces a fresh alloc on every apply
}

/**
 * zot's config.json for an S3-backed, htpasswd-protected registry. The S3 driver
 * is the docker/distribution one; R2/MinIO need path-style addressing. Credentials
 * live in the rendered config (via a Nomad template stanza) — acceptable on this
 * single-tenant cluster; a follow-up can move them to Nomad Variables.
 */
export const generateZotConfig = (s3: ZotS3Config): string =>
	JSON.stringify(
		{
			distSpecVersion: "1.1.1",
			storage: {
				rootDirectory: "/tmp/zot",
				// dedupe needs a remote cache DB (DynamoDB) when storage is remote (S3);
				// we don't run one, so turn it off — zot keeps a local boltdb cache and
				// stores blobs in S3. Without this zot refuses to start ("dedupe set to
				// true with remote storage … but no remote database configured").
				dedupe: false,
				storageDriver: {
					name: "s3",
					// The distribution S3 driver requires an ABSOLUTE key prefix
					// ("invalid path" otherwise), so normalize a leading slash.
					rootdirectory: s3.rootDirectory.startsWith("/")
						? s3.rootDirectory
						: `/${s3.rootDirectory}`,
					region: s3.region,
					regionendpoint: s3.endpoint,
					bucket: s3.bucket,
					accesskey: s3.accessKey,
					secretkey: s3.secretKey,
					secure: true,
					forcepathstyle: true,
				},
			},
			http: {
				address: "0.0.0.0",
				port: String(ZOT_PORT),
				auth: { htpasswd: { path: "/etc/zot/htpasswd" } },
			},
			log: { level: "info" },
		},
		null,
		2,
	);

/**
 * A Nomad job running zot as nomploy's container registry: S3-backed (stateless,
 * so it reschedules freely), htpasswd-protected, and exposed through the existing
 * Traefik/consulCatalog ingress on `domain` with TLS — so cluster nodes pull over
 * a valid cert with no per-node `insecure-registries` daemon config. The config
 * and htpasswd render via template stanzas and bind into the container.
 */
export const generateZotRegistryJob = (opts: ZotRegistryJobOptions): string => {
	const { appName, domain, htpasswd, s3, certResolver, deployedAt } = opts;
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
	const config = generateZotConfig(s3);

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
${htpasswd}
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
