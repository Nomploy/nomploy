/**
 * nomploy — Nomad bootstrap.
 *
 * Generates a shell script (run over SSH on a target server, the same way
 * Dokploy's `serverSetup` runs `installRequirements`) that installs and starts a
 * single-node HashiCorp stack:
 *   - Docker (container runtime)
 *   - Consul (service discovery — Traefik reads services from its catalog)
 *   - Nomad (orchestrator, server + client on one node)
 *   - CNI plugins (required for Nomad bridge networking)
 *
 * After this runs, `setupNomad()` (nomad-setup.ts) can bring up Traefik, the
 * databases, and the autoscaler, because Nomad/Consul/Docker are now present.
 *
 * Multi-node: bootstrap the first node as the server, then bootstrap additional
 * nodes as clients with `serverMode:false` and `retryJoin` pointing at the
 * server's private IP.
 */

export interface NomadBootstrapOptions {
	/** Datacenter name Nomad/Consul register under. */
	datacenter?: string;
	/** Address to advertise/bind on (defaults to auto-detected private IP). */
	bindAddr?: string;
	/** Run as a Nomad+Consul server (true) or client-only node (false). */
	serverMode?: boolean;
	/** Server addresses a client node should join (private IPs). */
	retryJoin?: string[];
	/** Nomad/Consul version to pin, or "latest" (default). */
	version?: string;
}

export const getNomadBootstrapCommand = (
	opts: NomadBootstrapOptions = {},
): string => {
	const datacenter = opts.datacenter || "dc1";
	const serverMode = opts.serverMode !== false;
	const retryJoin = opts.retryJoin ?? [];
	const bindExpr = opts.bindAddr
		? `"${opts.bindAddr}"`
		: // GO template resolved by Consul/Nomad to the first private interface.
			`"{{ GetPrivateIP }}"`;

	// Consul retry_join list (client nodes point at the server).
	const consulRetryJoin =
		retryJoin.length > 0
			? `retry_join = [${retryJoin.map((h) => `"${h}"`).join(", ")}]`
			: "";

	return `
set -e
CURRENT_USER=$USER
if [ "$EUID" -eq 0 ]; then
  SUDO=""
else
  if sudo -n true 2>/dev/null; then
    SUDO="sudo"
  else
    echo "Error: needs root or passwordless sudo. ❌"
    echo "  echo '$CURRENT_USER ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/$CURRENT_USER"
    exit 1
  fi
fi

OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) CNI_ARCH=amd64 ;;
  aarch64|arm64) CNI_ARCH=arm64 ;;
  *) echo "Unsupported arch: $ARCH ❌"; exit 1 ;;
esac

echo "==> Installing Nomad stack on $OS_TYPE ($ARCH)"

# ── Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker
else
  echo "Docker already installed ✅"
fi

# ── HashiCorp repo + Consul/Nomad ─────────────────────────────────────────
install_hashicorp_debian() {
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -y
  $SUDO apt-get install -y curl gnupg lsb-release
  curl -fsSL https://apt.releases.hashicorp.com/gpg | $SUDO gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | $SUDO tee /etc/apt/sources.list.d/hashicorp.list
  $SUDO apt-get update -y
  $SUDO apt-get install -y nomad consul
}

install_hashicorp_rhel() {
  $SUDO yum install -y yum-utils
  $SUDO yum-config-manager --add-repo https://rpm.releases.hashicorp.com/RHEL/hashicorp.repo
  $SUDO yum -y install nomad consul
}

if ! command -v nomad >/dev/null 2>&1 || ! command -v consul >/dev/null 2>&1; then
  case "$OS_TYPE" in
    ubuntu|debian|raspbian|pop|linuxmint|zorin) install_hashicorp_debian ;;
    centos|rhel|rocky|almalinux|fedora|amzn|ol) install_hashicorp_rhel ;;
    *) echo "Unsupported OS for auto-install: $OS_TYPE. Install nomad+consul manually. ❌"; exit 1 ;;
  esac
else
  echo "Nomad + Consul already installed ✅"
fi

# ── CNI plugins (needed for Nomad bridge networking) ──────────────────────
if [ ! -f /opt/cni/bin/bridge ]; then
  echo "==> Installing CNI plugins"
  CNI_VERSION=v1.5.1
  $SUDO mkdir -p /opt/cni/bin
  curl -fsSL "https://github.com/containernetworking/plugins/releases/download/\${CNI_VERSION}/cni-plugins-linux-\${CNI_ARCH}-\${CNI_VERSION}.tgz" \\
    | $SUDO tar -C /opt/cni/bin -xz
else
  echo "CNI plugins already present ✅"
fi
# Let bridged traffic traverse iptables (required by Nomad bridge mode).
echo 1 | $SUDO tee /proc/sys/net/bridge/bridge-nf-call-iptables >/dev/null 2>&1 || true

# ── Consul config ─────────────────────────────────────────────────────────
$SUDO mkdir -p /etc/consul.d /opt/consul
$SUDO tee /etc/consul.d/consul.hcl >/dev/null <<'CONSULHCL'
data_dir  = "/opt/consul"
bind_addr = ${bindExpr}
client_addr = "0.0.0.0"
datacenter = "${datacenter}"
${serverMode ? "server = true\nbootstrap_expect = 1\nui_config { enabled = true }" : "server = false"}
${consulRetryJoin}
CONSULHCL

# ── Nomad config ──────────────────────────────────────────────────────────
$SUDO mkdir -p /etc/nomad.d /opt/nomad
$SUDO tee /etc/nomad.d/nomad.hcl >/dev/null <<'NOMADHCL'
data_dir  = "/opt/nomad"
bind_addr = "0.0.0.0"
datacenter = "${datacenter}"

advertise {
  http = ${bindExpr}
  rpc  = ${bindExpr}
  serf = ${bindExpr}
}

${serverMode ? "server {\n  enabled          = true\n  bootstrap_expect = 1\n}" : "server { enabled = false }"}

client {
  enabled = true
  ${retryJoin.length > 0 ? `servers = [${retryJoin.map((h) => `"${h}"`).join(", ")}]` : ""}
}

consul {
  address = "127.0.0.1:8500"
}

plugin "docker" {
  config {
    allow_privileged = true
    # Lets Nomad pull from private registries you've logged into.
    auth {
      config = "/root/.docker/config.json"
    }
  }
}
NOMADHCL

# ── Enable + start services ───────────────────────────────────────────────
echo "==> Starting Consul and Nomad"
$SUDO systemctl enable consul nomad
$SUDO systemctl restart consul
sleep 3
$SUDO systemctl restart nomad

# ── Wait for Nomad API ────────────────────────────────────────────────────
echo "==> Waiting for Nomad API on :4646"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4646/v1/agent/health >/dev/null 2>&1; then
    echo "Nomad is up ✅"
    break
  fi
  sleep 2
done

nomad node status || true
echo "==> Nomad bootstrap complete ✅"
`;
};
