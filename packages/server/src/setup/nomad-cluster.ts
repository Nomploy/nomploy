/**
 * nomploy — multi-node cluster (WireGuard mesh).
 *
 * The control plane is a WireGuard "hub" (wg0 = 10.10.0.1/24, UDP 51820) running
 * the Consul + Nomad servers, bound to their WireGuard IP. Worker nodes get a
 * WireGuard IP on the same overlay, peer with the hub, and run Consul + Nomad as
 * clients that join over the encrypted overlay.
 *
 * `getClusterWorkerJoinCommand` produces a single script (run over SSH on a
 * fresh worker) that installs Docker + Consul + Nomad + CNI + WireGuard, brings
 * up the overlay, prints its WireGuard public key (the caller then registers it
 * as a peer on the hub with `wg set wg0 peer <key> allowed-ips <ip>/32`), and
 * starts Consul + Nomad as clients that retry-join the hub. Consul/Nomad keep
 * retrying, so they connect as soon as the hub adds the peer.
 *
 * The worker's public key is emitted on its own line as:
 *     WORKER_WG_PUBKEY=<base64>
 * so the orchestrator can parse it from the streamed output.
 */

export interface ClusterWorkerJoinOptions {
	/** WireGuard public key of the hub (control plane). */
	hubPublicKey: string;
	/** How the worker reaches the hub's WireGuard endpoint, host:port. */
	hubEndpoint: string;
	/** Shared Consul/Nomad gossip encryption key (base64, from `consul keygen`). */
	gossipKey: string;
	/** WireGuard overlay IP assigned to this worker, e.g. "10.10.0.2". */
	workerWgIp: string;
	/** Hub's WireGuard overlay IP (Consul/Nomad servers), default "10.10.0.1". */
	hubWgIp?: string;
	/** WireGuard overlay CIDR, default "10.10.0.0/24". */
	overlayCidr?: string;
	datacenter?: string;
	cniVersion?: string;
}

export const getClusterWorkerJoinCommand = (
	opts: ClusterWorkerJoinOptions,
): string => {
	const hubWgIp = opts.hubWgIp || "10.10.0.1";
	const overlayCidr = opts.overlayCidr || "10.10.0.0/24";
	const datacenter = opts.datacenter || "dc1";
	const cniVersion = opts.cniVersion || "v1.5.1";

	return `
set -e
if [ "$EUID" -ne 0 ] && ! sudo -n true 2>/dev/null; then
  echo "Error: needs root or passwordless sudo. ❌"; exit 1
fi
SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"
export DEBIAN_FRONTEND=noninteractive
OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d= -f2 | tr -d '"')
ARCH=$(uname -m); case "$ARCH" in x86_64) CNI_ARCH=amd64;; aarch64|arm64) CNI_ARCH=arm64;; *) echo "unsupported arch $ARCH"; exit 1;; esac

echo "==> Installing Docker"
command -v docker >/dev/null 2>&1 || { curl -fsSL https://get.docker.com | $SUDO sh; $SUDO systemctl enable --now docker; }

echo "==> Installing Consul + Nomad + WireGuard"
if ! command -v nomad >/dev/null 2>&1 || ! command -v consul >/dev/null 2>&1 || ! command -v wg >/dev/null 2>&1; then
  case "$OS_TYPE" in
    ubuntu|debian|raspbian|pop|linuxmint|zorin)
      $SUDO apt-get update -y
      $SUDO apt-get install -y curl gnupg lsb-release wireguard wireguard-tools
      curl -fsSL https://apt.releases.hashicorp.com/gpg | $SUDO gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
      echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | $SUDO tee /etc/apt/sources.list.d/hashicorp.list
      $SUDO apt-get update -y; $SUDO apt-get install -y nomad consul ;;
    centos|rhel|rocky|almalinux|fedora|amzn|ol)
      $SUDO yum install -y yum-utils wireguard-tools
      $SUDO yum-config-manager --add-repo https://rpm.releases.hashicorp.com/RHEL/hashicorp.repo
      $SUDO yum -y install nomad consul ;;
    *) echo "unsupported OS $OS_TYPE"; exit 1 ;;
  esac
fi

# CNI plugins
if [ ! -f /opt/cni/bin/bridge ]; then
  $SUDO mkdir -p /opt/cni/bin
  curl -fsSL "https://github.com/containernetworking/plugins/releases/download/${cniVersion}/cni-plugins-linux-\${CNI_ARCH}-${cniVersion}.tgz" | $SUDO tar -C /opt/cni/bin -xz
fi

# Docker auth config (docker driver needs this file to exist, even for public pulls)
$SUDO mkdir -p /root/.docker
[ -s /root/.docker/config.json ] || echo '{"auths":{}}' | $SUDO tee /root/.docker/config.json >/dev/null

# ── WireGuard: join the overlay, peer with the hub ─────────────────────────
$SUDO mkdir -p /etc/wireguard && $SUDO chmod 700 /etc/wireguard
$SUDO rm -f /etc/wireguard/w_priv /etc/wireguard/w_pub
$SUDO sh -c 'wg genkey > /etc/wireguard/w_priv && chmod 600 /etc/wireguard/w_priv && wg pubkey < /etc/wireguard/w_priv > /etc/wireguard/w_pub'
$SUDO tee /etc/wireguard/wg0.conf >/dev/null <<WG
[Interface]
Address = ${opts.workerWgIp}/24
PrivateKey = $($SUDO cat /etc/wireguard/w_priv)
[Peer]
PublicKey = ${opts.hubPublicKey}
Endpoint = ${opts.hubEndpoint}
AllowedIPs = ${overlayCidr}
PersistentKeepalive = 25
WG
$SUDO chmod 600 /etc/wireguard/wg0.conf
$SUDO wg-quick down wg0 >/dev/null 2>&1 || true
$SUDO wg-quick up wg0
$SUDO systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
echo "WORKER_WG_PUBKEY=$($SUDO cat /etc/wireguard/w_pub)"

# ── Consul client ──────────────────────────────────────────────────────────
$SUDO mkdir -p /etc/consul.d /opt/consul /etc/nomad.d /opt/nomad
$SUDO tee /etc/consul.d/consul.hcl >/dev/null <<CONSUL
data_dir    = "/opt/consul"
bind_addr   = "${opts.workerWgIp}"
client_addr = "127.0.0.1"
datacenter  = "${datacenter}"
server  = false
encrypt = "${opts.gossipKey}"
retry_join = ["${hubWgIp}"]
CONSUL

# ── Nomad client ───────────────────────────────────────────────────────────
$SUDO tee /etc/nomad.d/nomad.hcl >/dev/null <<NOMAD
data_dir   = "/opt/nomad"
bind_addr  = "0.0.0.0"
datacenter = "${datacenter}"
advertise {
  http = "${opts.workerWgIp}"
  rpc  = "${opts.workerWgIp}"
  serf = "${opts.workerWgIp}"
}
server { enabled = false }
client {
  enabled = true
  servers = ["${hubWgIp}:4647"]
  # Bind & register allocation ports on the WireGuard overlay, not the public
  # NIC, so Traefik on the control plane can reach services here (and ports are
  # never exposed publicly). Without this, Consul registers the node's public IP
  # and cross-node routing fails behind a cloud firewall.
  network_interface = "wg0"
}
consul { address = "127.0.0.1:8500" }
plugin "docker" {
  config {
    allow_privileged = true
    auth { config = "/root/.docker/config.json" }
  }
}
NOMAD

echo "==> Starting Consul + Nomad clients"
$SUDO systemctl enable consul nomad >/dev/null 2>&1 || true
$SUDO systemctl restart --no-block consul
sleep 3
$SUDO systemctl restart --no-block nomad
echo "==> Worker join complete. It will register once the hub adds its WireGuard peer."
`;
};
