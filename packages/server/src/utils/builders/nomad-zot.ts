import { encodeBase64 } from "../docker/utils";

/**
 * Built-in OCI registry (zot) that runs as a Nomad job on the control plane, so
 * nomploy can build → push → pull images without an external registry. zot is a
 * single-binary, OCI-native, Apache-2.0 registry (CNCF) that stores images on
 * the local filesystem or an S3-compatible backend.
 *
 * This module only GENERATES the config + Nomad job + deploy command; the setup
 * service wires it up (writes files, runs the job, records a `registry` row).
 */

export const ZOT_JOB_NAME = "nomploy-registry";
// Where the job's config + htpasswd live on the control-plane host (bind-mounted
// into the container) and where local-mode blobs are stored.
export const ZOT_ETC_DIR = "/etc/nomploy/registry";
export const ZOT_DATA_DIR = "/opt/nomploy/registry";
const ZOT_JOB_FILE = "/etc/nomploy/registry.nomad.hcl";
const ZOT_CONFIG_PATH = `${ZOT_ETC_DIR}/config.json`;
const ZOT_HTPASSWD_PATH = `${ZOT_ETC_DIR}/htpasswd`;
// zot publishes per-arch images; the control plane (hub) is amd64.
const DEFAULT_ZOT_IMAGE = "ghcr.io/project-zot/zot-linux-amd64:v2.1.5";

export type ZotStorage =
	| { kind: "local" }
	| {
			kind: "s3";
			bucket: string;
			region: string;
			/** S3-compatible endpoint host (e.g. minio.example.com); omit for AWS. */
			endpoint?: string;
			/** Whether the endpoint uses TLS (default true). */
			secure?: boolean;
	  };

export interface ZotOptions {
	/** Host port the registry listens on (network_mode=host). */
	port: number;
	image?: string;
	storage: ZotStorage;
	/** S3 credentials, passed as env (kept out of the on-disk config). */
	s3AccessKeyId?: string;
	s3SecretAccessKey?: string;
}

/**
 * Render zot's config.json. Storage is local by default; S3 mode uses the
 * docker/distribution s3 driver (credentials come from the AWS_* env, not here).
 */
export const generateZotConfig = (opts: ZotOptions): string => {
	const storage: Record<string, unknown> = {
		rootDirectory: ZOT_DATA_DIR,
		// Hard-link dedupe identical blobs to save disk (e.g. shared base layers).
		dedupe: true,
		// Reclaim orphaned blobs + prune untagged (dangling) manifests, which pile
		// up every time a moving tag like :latest is re-pushed. Keeps ALL tagged
		// images; only untagged/unreferenced content is collected.
		gc: true,
		gcDelay: "1h",
		gcInterval: "1h",
		retention: {
			policies: [{ repositories: ["**"], deleteUntagged: true }],
		},
	};
	if (opts.storage.kind === "s3") {
		storage.storageDriver = {
			name: "s3",
			rootdirectory: "/nomploy",
			region: opts.storage.region,
			bucket: opts.storage.bucket,
			secure: opts.storage.secure ?? true,
			...(opts.storage.endpoint
				? { regionendpoint: opts.storage.endpoint }
				: {}),
			// Put credentials in the driver config so auth doesn't rely on the s3
			// driver consulting the AWS env chain (also set as env below). Omitted
			// when empty → falls back to the instance's IAM role / env.
			...(opts.s3AccessKeyId ? { accesskey: opts.s3AccessKeyId } : {}),
			...(opts.s3SecretAccessKey ? { secretkey: opts.s3SecretAccessKey } : {}),
		};
	}
	const config = {
		distSpecVersion: "1.1.0",
		storage,
		http: {
			address: "0.0.0.0",
			port: String(opts.port),
			auth: { htpasswd: { path: ZOT_HTPASSWD_PATH } },
		},
		log: { level: "info" },
		extensions: {
			// GraphQL search + Trivy-backed CVE scanning. The panel surfaces the CVE
			// data in the image browser (no zui needed). Trivy's DB downloads to
			// <storage>/_trivy/db and refreshes on updateInterval; scanning can spike
			// memory, hence the registry job's raised memory_max.
			search: { enable: true, cve: { updateInterval: "2h" } },
		},
	};
	return JSON.stringify(config, null, 2);
};

/**
 * Render the zot Nomad job. Pinned to the control-plane node (like the panel),
 * host-networked so it's reachable at the overlay IP:port, bind-mounting the
 * config/htpasswd and (local mode) the blob store.
 */
export const generateZotNomadJob = (
	opts: ZotOptions,
	deployedAt: string = new Date().toISOString(),
): string => {
	const image = opts.image || DEFAULT_ZOT_IMAGE;
	const env: Record<string, string> = {};
	if (opts.storage.kind === "s3") {
		if (opts.s3AccessKeyId) env.AWS_ACCESS_KEY_ID = opts.s3AccessKeyId;
		if (opts.s3SecretAccessKey)
			env.AWS_SECRET_ACCESS_KEY = opts.s3SecretAccessKey;
	}
	const envBlock = Object.keys(env).length
		? `\n      env {\n${Object.entries(env)
				.map(([k, v]) => `        ${k} = ${JSON.stringify(v)}`)
				.join("\n")}\n      }\n`
		: "";

	return `job "${ZOT_JOB_NAME}" {
  namespace = "default"
  type      = "service"

  // Registry lives on the control plane (persistent storage / S3 creds there).
  constraint {
    attribute = "\${meta.nomploy_control_plane}"
    value     = "true"
  }

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

  group "${ZOT_JOB_NAME}" {
    count = 1

    restart {
      attempts = 3
      interval = "5m"
      delay    = "15s"
      mode     = "delay"
    }

    task "${ZOT_JOB_NAME}" {
      driver = "docker"

      config {
        image        = ${JSON.stringify(image)}
        force_pull   = true
        network_mode = "host"
        args         = ["serve", "${ZOT_CONFIG_PATH}"]
        volumes = [
          "${ZOT_ETC_DIR}:${ZOT_ETC_DIR}",
          "${ZOT_DATA_DIR}:${ZOT_DATA_DIR}",
        ]
      }
${envBlock}
      resources {
        cpu        = 500
        memory     = 512
        memory_max = 1024
      }
    }
  }
}
`;
};

/**
 * Shell command that writes zot's config.json + htpasswd + job file and submits
 * the job. `htpasswdLine` is a full `user:bcrypthash` line (generated by the
 * setup service so the plaintext password never lands on disk here).
 */
export const getZotDeployCommand = (
	opts: ZotOptions,
	htpasswdLine: string,
): string => {
	const encodedConfig = encodeBase64(generateZotConfig(opts));
	const encodedJob = encodeBase64(generateZotNomadJob(opts));
	const encodedHtpasswd = encodeBase64(`${htpasswdLine}\n`);
	return `
set -e
{
	mkdir -p "${ZOT_ETC_DIR}" "${ZOT_DATA_DIR}"
	echo "${encodedConfig}" | base64 -d > "${ZOT_CONFIG_PATH}"
	echo "${encodedHtpasswd}" | base64 -d > "${ZOT_HTPASSWD_PATH}"
	chmod 600 "${ZOT_HTPASSWD_PATH}"
	echo "${encodedJob}" | base64 -d > "${ZOT_JOB_FILE}"
	echo "Registry config written: ✅"
	nomad job run "${ZOT_JOB_FILE}" 2>&1
	echo "Registry (zot) deployed: ✅"
} || {
	echo "Error: ❌ Registry deployment failed"
	exit 1
}
`;
};
