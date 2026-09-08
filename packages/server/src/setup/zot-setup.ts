import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { registry, zotRegistry } from "../db/schema";
import {
	getZotDeployCommand,
	type ZotOptions,
	type ZotStorage,
} from "../utils/builders/nomad-zot";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { readCluster } from "./nomad-mesh";

type Log = (s: string) => void;

/** The overlay address the built-in registry is reachable at (hub wg IP:port). */
const registryAddress = (port: number): string => {
	const cluster = readCluster();
	const hub = cluster?.hubWgIp || "10.10.0.1";
	return `${hub}:${port}`;
};

const toStorage = (cfg: typeof zotRegistry.$inferSelect): ZotStorage =>
	cfg.storageKind === "s3"
		? {
				kind: "s3",
				bucket: cfg.s3Bucket || "",
				region: cfg.s3Region || "",
				endpoint: cfg.s3Endpoint || undefined,
			}
		: { kind: "local" };

// The daemon.json edit + docker reload (SIGHUP re-reads insecure-registries
// WITHOUT restarting containers, so the panel + allocs are undisturbed).
const insecureRegistryScript = (
	addr: string,
) => `SUDO=""; [ "$EUID" -ne 0 ] && SUDO=sudo
$SUDO python3 - "${addr}" <<'PY'
import json, os, sys
addr = sys.argv[1]
path = "/etc/docker/daemon.json"
cfg = {}
if os.path.exists(path):
    try:
        cfg = json.load(open(path)) or {}
    except Exception:
        cfg = {}
lst = cfg.get("insecure-registries") or []
if addr not in lst:
    lst.append(addr)
    cfg["insecure-registries"] = lst
    json.dump(cfg, open(path, "w"), indent=2)
    print("added")
else:
    print("present")
PY
$SUDO systemctl reload docker 2>/dev/null || $SUDO kill -HUP "$(cat /var/run/docker.pid 2>/dev/null)" 2>/dev/null || true`;

/**
 * Allow the built-in (HTTP) registry on every node's Docker: the control plane
 * (so builds push) AND all worker peers (so their allocations can pull). Uses a
 * non-disruptive reload. Existing workers are covered here; new workers pick it
 * up on the next enable/reconfigure.
 */
const configureInsecureRegistry = async (addr: string, onLog: Log) => {
	const script = insecureRegistryScript(addr);
	onLog(`Allowing insecure registry ${addr} on the control plane…\n`);
	await execAsync(script).catch((e) =>
		onLog(
			`⚠ insecure-registry config: ${e instanceof Error ? e.message : e}\n`,
		),
	);
	for (const p of readCluster()?.peers ?? []) {
		onLog(`Allowing insecure registry on worker ${p.name}…\n`);
		await execAsyncRemote(p.serverId, script).catch((e) =>
			onLog(`⚠ ${p.name}: ${e instanceof Error ? e.message : e}\n`),
		);
	}
};

/** Wait until the registry answers the OCI base endpoint (/v2/). */
const waitForRegistry = async (addr: string, onLog: Log): Promise<boolean> => {
	for (let i = 0; i < 30; i++) {
		try {
			const { stdout } = await execAsync(
				`curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://${addr}/v2/ || true`,
			);
			// 200 or 401 (auth required) both mean the registry is up.
			if (stdout.trim() === "200" || stdout.trim() === "401") {
				onLog("Registry is up ✅\n");
				return true;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 3000));
	}
	onLog("⚠ registry did not become ready in time\n");
	return false;
};

/**
 * Enable (or reconfigure) the built-in zot registry for an org: deploy the Nomad
 * job, allow the insecure registry on the control plane, wait for health, and
 * upsert the `registry` row + persisted config so builds can target it.
 */
export const enableZotRegistry = async (
	organizationId: string,
	onLog: Log = () => {},
): Promise<{ registryId: string; address: string }> => {
	const cfg = await db.query.zotRegistry.findFirst({
		where: eq(zotRegistry.organizationId, organizationId),
	});
	if (!cfg) throw new Error("No registry config — save settings first.");
	if (cfg.storageKind === "s3" && (!cfg.s3Bucket || !cfg.s3Region)) {
		throw new Error("S3 storage needs at least a bucket and region.");
	}
	if (!cfg.password) throw new Error("Set a registry password first.");

	const addr = registryAddress(cfg.port);
	const opts: ZotOptions = {
		port: cfg.port,
		storage: toStorage(cfg),
		s3AccessKeyId: cfg.s3AccessKeyId || undefined,
		s3SecretAccessKey: cfg.s3SecretAccessKey || undefined,
	};

	// zot's htpasswd accepts bcrypt; hash here so the plaintext never lands on disk.
	const hash = await bcrypt.hash(cfg.password, 10);
	onLog("Deploying registry (zot)…\n");
	await execAsync(getZotDeployCommand(opts, `${cfg.username}:${hash}`));
	await configureInsecureRegistry(addr, onLog);
	await waitForRegistry(addr, onLog);

	// docker login from the control plane so builds can push.
	await execAsync(
		`printf %s '${cfg.password.replace(/'/g, "'\\''")}' | docker login ${addr} -u '${cfg.username}' --password-stdin`,
	).catch((e) =>
		onLog(`⚠ docker login: ${e instanceof Error ? e.message : e}\n`),
	);

	// Upsert the registry row (reuse the existing one if present).
	let registryId = cfg.registryId || "";
	if (registryId) {
		await db
			.update(registry)
			.set({
				registryUrl: addr,
				username: cfg.username,
				password: cfg.password,
				imagePrefix: "nomploy",
			})
			.where(eq(registry.registryId, registryId));
	} else {
		const [row] = await db
			.insert(registry)
			.values({
				registryName: "Built-in registry (zot)",
				imagePrefix: "nomploy",
				username: cfg.username,
				password: cfg.password,
				registryUrl: addr,
				registryType: "selfHosted",
				organizationId,
			})
			.returning();
		if (!row) throw new Error("Failed to create the registry row");
		registryId = row.registryId;
	}

	await db
		.update(zotRegistry)
		.set({ enabled: true, registryId })
		.where(eq(zotRegistry.organizationId, organizationId));

	onLog(`Built-in registry ready at ${addr} ✅\n`);
	return { registryId, address: addr };
};

/** Stop the built-in registry job + mark disabled (keeps stored blobs + config). */
export const disableZotRegistry = async (
	organizationId: string,
	onLog: Log = () => {},
): Promise<void> => {
	onLog("Stopping registry job…\n");
	await execAsync("nomad job stop -purge nomploy-registry 2>&1").catch(
		() => {},
	);
	await db
		.update(zotRegistry)
		.set({ enabled: false })
		.where(eq(zotRegistry.organizationId, organizationId));
	onLog("Registry disabled.\n");
};
