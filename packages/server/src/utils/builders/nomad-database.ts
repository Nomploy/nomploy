import { encodeBase64, getEnvironmentVariablesObject } from "../docker/utils";

/**
 * Normalized input for a stateful database → Nomad job. Every Dokploy database
 * type (postgres/mysql/mariadb/mongo/redis/libsql) reduces to this.
 */
export interface NomadDatabaseInput {
	/** Nomad job id (the service appName). */
	appName: string;
	image: string;
	/** In-container port the engine listens on (5432, 3306, 6379, …). */
	containerPort: number;
	/** Optional fixed host port for external access (psql from outside, etc.). */
	externalPort?: number | null;
	/** Container path whose data must survive restarts (the engine's data dir). */
	dataPath: string;
	/** Service env (KEY=val lines) — already includes engine defaults. */
	env: string | null;
	projectEnv?: string | null;
	environmentEnv?: string | null;
	/** Swarm-era units: NanoCPUs (1 core = 1e9) and bytes. */
	cpuLimit?: string | null;
	memoryLimit?: string | null;
	command?: string | null;
	args?: string[] | null;
	/**
	 * Node to pin the database to. A database keeps its data in a node-local
	 * volume, so it must always run on the same node — otherwise a reschedule
	 * would start it against a fresh, empty volume. Required for correctness.
	 */
	targetNodeName: string;
	mounts?: {
		type: string;
		volumeName?: string | null;
		hostPath?: string | null;
		mountPath: string;
	}[];
}

const hclString = (s: string) => JSON.stringify(s);

/**
 * Generate the Nomad HCL for a stateful single-instance database:
 * - count = 1, pinned to its node (node-local data volume).
 * - a named docker volume for the data dir (persists across restarts/redeploys)
 *   plus any user-defined mounts.
 * - a dynamic port mapped to the engine port (avoids fixed-port clashes when
 *   several databases share a node) registered in Consul as the appName so other
 *   services discover host:port; an optional fixed external port when requested.
 */
export const generateDatabaseNomadJob = (db: NomadDatabaseInput): string => {
	const env = getEnvironmentVariablesObject(
		db.env,
		db.projectEnv ?? null,
		db.environmentEnv ?? null,
	);
	const envLines = Object.entries(env)
		.map(([k, v]) => `        ${k} = ${hclString(v)}`)
		.join("\n");

	const cpu = db.cpuLimit
		? Math.round(Number.parseInt(db.cpuLimit) / 1_000_000)
		: 500;
	const memory = db.memoryLimit
		? Math.round(Number.parseInt(db.memoryLimit) / (1024 * 1024))
		: 512;

	// Configured mounts as docker driver volume strings. Databases already carry a
	// volume mount for their data dir, so add a fallback named volume only if no
	// mount targets the data path (avoids a duplicate mount point).
	const volumes: string[] = [];
	for (const m of db.mounts || []) {
		if (m.type === "volume" && m.volumeName)
			volumes.push(`${m.volumeName}:${m.mountPath}`);
		else if (m.type === "bind" && m.hostPath)
			volumes.push(`${m.hostPath}:${m.mountPath}`);
	}
	if (!volumes.some((v) => v.endsWith(`:${db.dataPath}`)))
		volumes.push(`${db.appName}-data:${db.dataPath}`);
	const volumesHcl = volumes.map(hclString).join(", ");

	// The engine listens on its standard port as a STATIC host port bound on the
	// WireGuard overlay, so other services reach it at "<appName>:<containerPort>"
	// (Consul resolves <appName> to this node). An optional extra external port can
	// be published too. (Two databases of the same engine pinned to one node would
	// clash on the static port — Nomad surfaces that as a placement failure.)
	const ports = [
		`        port "db" {\n          static = ${db.containerPort}\n        }`,
	];
	if (db.externalPort && db.externalPort !== db.containerPort)
		ports.push(
			`        port "external" {\n          static = ${db.externalPort}\n          to     = ${db.containerPort}\n        }`,
		);

	const commandLine = db.command
		? `\n        command = ${hclString(db.command)}`
		: "";
	const argsLine =
		db.args && db.args.length > 0
			? `\n        args = ${JSON.stringify(db.args)}`
			: "";

	return `job ${hclString(db.appName)} {
  datacenters = ["dc1"]
  type        = "service"

  constraint {
    attribute = "\${node.unique.name}"
    value     = ${hclString(db.targetNodeName)}
  }

  group "db" {
    count = 1

    network {
      dns {
        servers  = ["10.10.0.1"]
        searches = ["service.consul"]
      }
${ports.join("\n")}
    }

    service {
      name     = ${hclString(db.appName)}
      port     = "db"
      provider = "consul"

      check {
        type     = "tcp"
        interval = "15s"
        timeout  = "5s"
      }
    }

    task "db" {
      driver = "docker"

      config {
        image   = ${hclString(db.image)}
        ports   = ["db"${db.externalPort ? ', "external"' : ""}]
        volumes = [${volumesHcl}]${commandLine}${argsLine}
      }

      env {
${envLines}
      }

      resources {
        cpu    = ${cpu}
        memory = ${memory}
      }
    }
  }
}
`;
};

/**
 * Deploy-script fragment: write the HCL and submit it to Nomad. The image is
 * pulled by Nomad on the (pinned) node. Mirrors the app/compose pipeline.
 */
export const getBuildNomadDatabaseCommand = (
	db: NomadDatabaseInput,
): string => {
	const jobFilePath = `/etc/nomploy/jobs/${db.appName}.nomad.hcl`;
	const encoded = encodeBase64(generateDatabaseNomadJob(db));
	return `
set -e
{
	mkdir -p /etc/nomploy/jobs
	echo "${encoded}" | base64 -d > "${jobFilePath}"
	echo "Nomad job file written: ✅"
	nomad job run "${jobFilePath}" 2>&1
	echo "Nomad Job Deployed: ✅"
} || {
	echo "Error: ❌ Nomad database deployment failed"
	exit 1
}
`;
};
