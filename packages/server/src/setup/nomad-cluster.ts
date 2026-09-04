/**
 * nomploy — multi-node cluster (WireGuard mesh, HA-capable).
 *
 * The control plane is the WireGuard hub (wg0 = 10.10.0.1/24, UDP 51820). Nodes
 * join over the encrypted overlay:
 *  - WORKERS run Consul + Nomad as clients. They peer every server (the hub as
 *    the /24 overlay gateway, other servers /32) so they fail over to a surviving
 *    server if the hub dies, and retry-join all servers.
 *  - SERVERS run Consul + Nomad as servers (raft quorum) AND a client. They
 *    full-mesh with the other servers, forward the overlay (like the hub), and
 *    retry-join the whole server set. They are NOT panel hosts (no
 *    nomploy_control_plane meta).
 *
 * Each join script installs Docker + Consul + Nomad + CNI + WireGuard, brings up
 * the overlay, and prints its WireGuard public key on its own line
 * (`WORKER_WG_PUBKEY=<b64>` / `SERVER_WG_PUBKEY=<b64>`) so the orchestrator can
 * register it as a peer on the existing members. Consul/Nomad keep retrying, so
 * the node connects as soon as the peers are added.
 */

/** A server this node must dial (full mesh / worker→server): needs an endpoint. */
export interface MeshServerPeer {
	wgIp: string;
	publicKey: string;
	endpoint: string;
}

/** A worker peer a server routes to: learned passively, no endpoint. */
export interface MeshWorkerPeer {
	wgIp: string;
	publicKey: string;
}

export interface ClusterWorkerJoinOptions {
	/** WireGuard public key of the hub (control plane). */
	hubPublicKey: string;
	/** How the worker reaches the hub's WireGuard endpoint, host:port. */
	hubEndpoint: string;
	/** Shared Consul/Nomad gossip encryption key (base64, from `consul keygen`). */
	gossipKey: string;
	/** WireGuard overlay IP assigned to this worker, e.g. "10.10.0.11". */
	workerWgIp: string;
	/** Hub's WireGuard overlay IP (Consul/Nomad server), default "10.10.0.1". */
	hubWgIp?: string;
	/** WireGuard overlay CIDR, default "10.10.0.0/24". */
	overlayCidr?: string;
	/** Extra servers (besides the hub) to also peer + retry-join, for HA. */
	servers?: MeshServerPeer[];
	datacenter?: string;
	cniVersion?: string;
}

export interface ClusterServerJoinOptions {
	/** WireGuard overlay IP assigned to this server, e.g. "10.10.0.2". */
	ownWgIp: string;
	/** Shared Consul/Nomad gossip encryption key. */
	gossipKey: string;
	/** Target server count for bootstrap_expect (min(currentCount, 3)). */
	bootstrapExpect: number;
	/** All server overlay IPs (incl. hub and this new one) for retry_join. */
	serverWgIps: string[];
	/** The other servers (incl. hub) to full-mesh with — need endpoints. */
	otherServers: MeshServerPeer[];
	/** Existing workers to route to (added as /32 peers, no endpoint). */
	existingWorkers?: MeshWorkerPeer[];
	overlayCidr?: string;
	datacenter?: string;
	cniVersion?: string;
}

/** Shared install steps (Docker + Consul + Nomad + CNI + WireGuard + docker auth). */
const installPreamble = (cniVersion: string): string => `
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

# consul-cni: needed by Consul Connect transparent proxy (Phase B segmentation).
if [ ! -f /opt/cni/bin/consul-cni ]; then
  CONSUL_CNI_VERSION="\${CONSUL_CNI_VERSION:-1.6.3}"
  $SUDO mkdir -p /opt/cni/bin
  command -v unzip >/dev/null 2>&1 || $SUDO apt-get install -y unzip >/dev/null 2>&1 || true
  tmpz="$(mktemp)"
  curl -fsSL "https://releases.hashicorp.com/consul-cni/\${CONSUL_CNI_VERSION}/consul-cni_\${CONSUL_CNI_VERSION}_linux_\${CNI_ARCH}.zip" -o "$tmpz" \
    && $SUDO unzip -o "$tmpz" -d /opt/cni/bin >/dev/null 2>&1
  rm -f "$tmpz"
fi

# Docker auth config (docker driver needs this file to exist, even for public pulls)
$SUDO mkdir -p /root/.docker
[ -s /root/.docker/config.json ] || echo '{"auths":{}}' | $SUDO tee /root/.docker/config.json >/dev/null
`;

/** wg [Peer] block with an endpoint (a server we dial). */
const serverPeerBlock = (p: MeshServerPeer): string => `
[Peer]
PublicKey = ${p.publicKey}
Endpoint = ${p.endpoint}
AllowedIPs = ${p.wgIp}/32
PersistentKeepalive = 25`;

/** wg [Peer] block for a worker (learned passively, no endpoint). */
const workerPeerBlock = (p: MeshWorkerPeer): string => `
[Peer]
PublicKey = ${p.publicKey}
AllowedIPs = ${p.wgIp}/32`;

export const getClusterWorkerJoinCommand = (
	opts: ClusterWorkerJoinOptions,
): string => {
	const hubWgIp = opts.hubWgIp || "10.10.0.1";
	const overlayCidr = opts.overlayCidr || "10.10.0.0/24";
	const datacenter = opts.datacenter || "dc1";
	const cniVersion = opts.cniVersion || "v1.5.1";
	const extraServers = opts.servers ?? [];

	// Nomad client + Consul join every server, so a worker survives losing one.
	const serverIps = [hubWgIp, ...extraServers.map((s) => s.wgIp)];
	const nomadServers = serverIps.map((ip) => `"${ip}:4647"`).join(", ");
	const consulRetryJoin = serverIps.map((ip) => `"${ip}"`).join(", ");
	// The hub is the overlay gateway (/24); other servers are direct (/32).
	const extraServerPeers = extraServers.map(serverPeerBlock).join("\n");

	return `${installPreamble(cniVersion)}
# ── WireGuard: join the overlay, peer with every server ────────────────────
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
PersistentKeepalive = 25${extraServerPeers}
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
retry_join = [${consulRetryJoin}]
# Connect mesh (Phase B): Envoy sidecars on this node reach the local agent's
# xDS over gRPC (8502, bound to 127.0.0.1 via client_addr).
connect { enabled = true }
ports { grpc = 8502 }
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
  servers = [${nomadServers}]
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
echo "==> Worker join complete. It will register once the servers add its WireGuard peer."
`;
};

export const getClusterServerJoinCommand = (
	opts: ClusterServerJoinOptions,
): string => {
	const overlayCidr = opts.overlayCidr || "10.10.0.0/24";
	const datacenter = opts.datacenter || "dc1";
	const cniVersion = opts.cniVersion || "v1.5.1";
	const consulRetryJoin = opts.serverWgIps.map((ip) => `"${ip}"`).join(", ");
	const serverPeers = opts.otherServers.map(serverPeerBlock).join("\n");
	const workerPeers = (opts.existingWorkers ?? [])
		.map(workerPeerBlock)
		.join("\n");

	return `${installPreamble(cniVersion)}
# ── WireGuard: full-mesh server, forward the overlay ───────────────────────
$SUDO mkdir -p /etc/wireguard && $SUDO chmod 700 /etc/wireguard
$SUDO rm -f /etc/wireguard/srv_priv /etc/wireguard/srv_pub
$SUDO sh -c 'wg genkey > /etc/wireguard/srv_priv && chmod 600 /etc/wireguard/srv_priv && wg pubkey < /etc/wireguard/srv_priv > /etc/wireguard/srv_pub'
$SUDO tee /etc/wireguard/wg0.conf >/dev/null <<WG
[Interface]
Address = ${opts.ownWgIp}/24
ListenPort = 51820
PrivateKey = $($SUDO cat /etc/wireguard/srv_priv)
PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT${serverPeers}${workerPeers}
WG
$SUDO chmod 600 /etc/wireguard/wg0.conf
$SUDO wg-quick down wg0 >/dev/null 2>&1 || true
$SUDO wg-quick up wg0
$SUDO systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
echo "SERVER_WG_PUBKEY=$($SUDO cat /etc/wireguard/srv_pub)"

# ── Consul server ──────────────────────────────────────────────────────────
$SUDO mkdir -p /etc/consul.d /opt/consul /etc/nomad.d /opt/nomad
$SUDO tee /etc/consul.d/consul.hcl >/dev/null <<CONSUL
data_dir    = "/opt/consul"
bind_addr   = "${opts.ownWgIp}"
client_addr = "127.0.0.1"
datacenter  = "${datacenter}"
server           = true
bootstrap_expect = ${opts.bootstrapExpect}
encrypt = "${opts.gossipKey}"
retry_join = [${consulRetryJoin}]
# Connect mesh (Phase B): enable service mesh + Envoy xDS gRPC on this server.
connect { enabled = true }
ports { grpc = 8502 }
CONSUL

# ── Nomad server + client ──────────────────────────────────────────────────
$SUDO tee /etc/nomad.d/nomad.hcl >/dev/null <<NOMAD
data_dir   = "/opt/nomad"
bind_addr  = "0.0.0.0"
datacenter = "${datacenter}"
advertise {
  http = "${opts.ownWgIp}"
  rpc  = "${opts.ownWgIp}"
  serf = "${opts.ownWgIp}"
}
server {
  enabled          = true
  bootstrap_expect = ${opts.bootstrapExpect}
  encrypt          = "${opts.gossipKey}"
  server_join {
    retry_join = [${consulRetryJoin}]
  }
}
client {
  enabled = true
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

echo "==> Starting Consul + Nomad servers"
$SUDO systemctl enable consul nomad >/dev/null 2>&1 || true
$SUDO systemctl restart --no-block consul
sleep 3
$SUDO systemctl restart --no-block nomad
echo "==> Server join complete. It will join raft once the other servers add its WireGuard peer."
`;
};
