import { encodeBase64, getEnvironmentVariablesObject } from "../docker/utils";
import { clusterDnsServers } from "./nomad";

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
	/**
	 * Additional container ports to publish as static overlay ports (e.g. libSQL's
	 * gRPC replication port). The primary containerPort is the discoverable one.
	 */
	extraPorts?: number[];
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

// The DB's data dir lives in a Nomad host volume named after the app.
const dataHostVolumeName = (db: NomadDatabaseInput): string =>
	`${db.appName}-data`;

// Use the managed host volume for the data dir unless the user already mounted
// their own storage there (a bind or named volume targeting db.dataPath).
const usesDataHostVolume = (db: NomadDatabaseInput): boolean =>
	!(db.mounts || []).some(
		(m) =>
			((m.type === "volume" && m.volumeName) ||
				(m.type === "bind" && m.hostPath)) &&
			m.mountPath === db.dataPath,
	);

/**
 * Generate the Nomad HCL for a stateful single-instance database:
 * - count = 1, pinned to its node (node-local data volume).
 * - a dynamic Nomad HOST VOLUME for the data dir (prune-immune and
 *   scheduler-aware — see usesDataHostVolume / getBuildNomadDatabaseCommand),
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

	// User-configured extra mounts as docker driver volume strings.
	const volumes: string[] = [];
	for (const m of db.mounts || []) {
		if (m.type === "volume" && m.volumeName)
			volumes.push(`${m.volumeName}:${m.mountPath}`);
		else if (m.type === "bind" && m.hostPath)
			volumes.push(`${m.hostPath}:${m.mountPath}`);
	}
	const volumesHcl = volumes.map(hclString).join(", ");

	// The engine's data dir persists in a Nomad HOST VOLUME (dynamic, created via
	// the mkdir plugin — see getBuildNomadDatabaseCommand), not a docker named
	// volume. A host volume is a node directory Nomad bind-mounts, so:
	//   • it's invisible to `docker volume prune` / `docker system prune --volumes`
	//     (which silently wiped a managed DB once), and
	//   • the scheduler refuses to place the DB on a node that lacks the volume, so
	//     missing data surfaces as a visible placement failure instead of Postgres
	//     re-initializing into an empty dir.
	// Skipped only when the user already mounted their own storage at the data dir.
	const useHostVolume = usesDataHostVolume(db);
	const dataVolumeStanza = useHostVolume
		? `    volume "data" {
      type   = "host"
      source = ${hclString(dataHostVolumeName(db))}
    }

`
		: "";
	const dataVolumeMount = useHostVolume
		? `
      volume_mount {
        volume      = "data"
        destination = ${hclString(db.dataPath)}
      }
`
		: "";

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
	for (const p of db.extraPorts || [])
		ports.push(`        port "p${p}" {\n          static = ${p}\n        }`);

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

${dataVolumeStanza}    network {
      dns {
        # All server overlay IPs (hub + HA servers), so a DB alloc still resolves
        # *.service.consul if the hub goes down. See clusterDnsServers().
        servers  = [${clusterDnsServers()
					.map((ip) => `"${ip}"`)
					.join(", ")}]
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
        ports   = ["db"${db.externalPort ? ', "external"' : ""}${(db.extraPorts || []).map((p) => `, "p${p}"`).join("")}]
        volumes = [${volumesHcl}]${commandLine}${argsLine}
      }
${dataVolumeMount}
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
	// Ensure the DB's data host volume exists on its node before the job (which
	// references it) is submitted. Dynamic host volume via the built-in `mkdir`
	// plugin: a prune-immune, scheduler-aware directory that replaces the old
	// docker named volume. Idempotent — created only when missing, so redeploys
	// reuse (and thus preserve) the existing data. `${...node.unique.name}` is a
	// literal for Nomad (single-quoted heredoc + JS-escaped so it isn't
	// interpolated here). Skipped when the user mounts their own data storage.
	const hostVolume = dataHostVolumeName(db);
	const volSpecPath = `/etc/nomploy/jobs/${db.appName}.volume.hcl`;
	const ensureVolume = usesDataHostVolume(db)
		? `
if ! nomad volume status -type host ${hclString(hostVolume)} >/dev/null 2>&1; then
  cat > "${volSpecPath}" <<'EOFVOL'
namespace = "default"
name      = ${hclString(hostVolume)}
type      = "host"
plugin_id = "mkdir"
capability {
  access_mode     = "single-node-writer"
  attachment_mode = "file-system"
}
constraint {
  attribute = "\${node.unique.name}"
  value     = ${hclString(db.targetNodeName)}
}
EOFVOL
  echo "Creating data host volume ${hostVolume} on ${db.targetNodeName}…"
  nomad volume create "${volSpecPath}"
fi`
		: "";
	// NOTE: don't wrap the submit in `{ … } || { … }` — bash suspends `set -e` inside a
	// group that's the left operand of `||`, so a failing `nomad job run` (e.g. a 403)
	// would keep going and still print success. Check the exit status explicitly.
	return `
set -e
mkdir -p /etc/nomploy/jobs
echo "${encoded}" | base64 -d > "${jobFilePath}"
echo "Nomad job file written: ✅"
${ensureVolume}
if ! nomad job run "${jobFilePath}" 2>&1; then
	echo "Error: ❌ Nomad database deployment failed"
	# Surface the container's own logs — the deployment error alone rarely shows
	# WHY the task died (e.g. mongo:8 refusing to boot on a new kernel). Best-effort.
	echo "----- recent logs from ${db.appName} -----"
	nomad alloc logs -job -stderr -tail -n 40 "${db.appName}" 2>/dev/null \
		|| nomad alloc logs -job -tail -n 40 "${db.appName}" 2>/dev/null \
		|| echo "(no allocation logs available — the task may not have started)"
	echo "-------------------------------------------"
	exit 1
fi
echo "Nomad Job Deployed: ✅"
`;
};
