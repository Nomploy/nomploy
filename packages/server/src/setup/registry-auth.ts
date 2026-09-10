import { db } from "../db";
import { execAsyncRemote } from "../utils/process/execAsync";
import { readCluster } from "./nomad-mesh";

/**
 * Cluster-wide docker registry auth via consul-template.
 *
 * The docker driver can only read pull credentials from a NODE-level
 * `/root/.docker/config.json` (a Nomad template renders too late — after the
 * image is already pulled). So we keep the merged auth in Consul KV and run
 * consul-template on every node to render that file and refresh it whenever the
 * KV value changes. Credentials never touch a job spec, are managed in one place,
 * and new/autoscaled nodes pick them up automatically.
 *
 * Caveat: Consul KV is plaintext, gated only by Consul ACLs (off by default), so
 * on a shared/multi-tenant cluster prefer Vault. Fine for a single-tenant private
 * WireGuard cluster.
 */

type Log = (s: string) => void;

// Consul KV key holding the rendered docker config.json ({auths}).
export const REGISTRY_AUTH_KV = "nomploy/docker-auth";
const DOCKER_CONFIG = "/root/.docker/config.json";
const consulKvUrl = (key: string) =>
	`${process.env.CONSUL_ADDRESS || "http://127.0.0.1:8500"}/v1/kv/${key}`;

/** Build a docker config.json ({auths}) from registries that carry credentials. */
export const buildDockerConfigJson = (
	regs: {
		registryUrl: string | null;
		username: string | null;
		password: string | null;
	}[],
): string => {
	const auths: Record<string, { auth: string }> = {};
	for (const r of regs) {
		if (!r.registryUrl || !r.username || !r.password) continue;
		auths[r.registryUrl] = {
			auth: Buffer.from(`${r.username}:${r.password}`).toString("base64"),
		};
	}
	return JSON.stringify({ auths });
};

/**
 * Rebuild the merged docker auth from every registry and publish it to Consul KV.
 * consul-template on each node renders it to /root/.docker/config.json. Call this
 * whenever a registry is created/updated/removed. Best-effort — callers should not
 * fail their operation if the KV write fails (e.g. Consul not reachable).
 */
export const syncRegistryAuthToConsul = async (): Promise<void> => {
	const regs = await db.query.registry.findMany();
	const config = buildDockerConfigJson(regs);
	const res = await fetch(consulKvUrl(REGISTRY_AUTH_KV), {
		method: "PUT",
		body: config,
	});
	if (!res.ok)
		throw new Error(`Consul KV write failed: ${res.status} ${res.statusText}`);
};

/**
 * Shell that installs consul-template on a node and configures it to render the
 * docker auth from Consul KV. Idempotent. Reused by the cluster-join preamble
 * (nomad-cluster.ts) and install.sh (control plane). `$SUDO` is provided by the
 * surrounding script.
 */
export const consulTemplateSetupScript = (): string => `
# ── Registry auth via consul-template ──────────────────────────────────────
# Renders ${DOCKER_CONFIG} from Consul KV so private-registry pulls work
# cluster-wide with no credentials in job specs; refreshes when the KV changes.
if ! command -v consul-template >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get install -y consul-template 2>&1 || true;
  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y consul-template 2>&1 || true; fi
fi
$SUDO mkdir -p /etc/consul-template.d /root/.docker
printf '%s\\n' '{{ keyOrDefault "${REGISTRY_AUTH_KV}" "{}" }}' | $SUDO tee /etc/consul-template.d/docker-auth.tpl >/dev/null
$SUDO tee /etc/consul-template.d/docker-auth.hcl >/dev/null <<'CT'
consul { address = "127.0.0.1:8500" }
template {
  source      = "/etc/consul-template.d/docker-auth.tpl"
  destination = "${DOCKER_CONFIG}"
  perms       = "0600"
}
CT
$SUDO tee /etc/systemd/system/nomploy-registry-auth.service >/dev/null <<'UNIT'
[Unit]
Description=nomploy registry auth (consul-template renders docker config)
After=consul.service network-online.target
[Service]
ExecStart=/usr/bin/consul-template -config /etc/consul-template.d/docker-auth.hcl
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload 2>/dev/null || true
$SUDO systemctl enable --now nomploy-registry-auth.service 2>&1 || true
`;

/**
 * Install + start the registry-auth renderer on every existing mesh member
 * (servers + workers) over SSH, and seed the Consul KV. The control-plane host is
 * handled by install.sh; new nodes get it via the join preamble.
 */
export const installRegistryAuthOnMembers = async (
	onLog: Log = () => {},
): Promise<void> => {
	await syncRegistryAuthToConsul().catch((e) =>
		onLog(`⚠ Consul KV: ${e instanceof Error ? e.message : String(e)}\n`),
	);
	const script = `SUDO=""; [ "$EUID" -ne 0 ] && SUDO=sudo\n${consulTemplateSetupScript()}`;
	const cluster = readCluster();
	const members = [...(cluster?.servers ?? []), ...(cluster?.peers ?? [])];
	for (const m of members) {
		if (!m.serverId) continue;
		onLog(`Installing registry auth on ${m.name}…\n`);
		await execAsyncRemote(m.serverId, script).catch((e) =>
			onLog(`⚠ ${m.name}: ${e instanceof Error ? e.message : String(e)}\n`),
		);
	}
};
