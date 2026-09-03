#!/bin/sh
# nomploy installer — sets up the nomploy control plane on a fresh Linux server.
#
#   curl -sSL https://raw.githubusercontent.com/Nomploy/nomploy/main/install.sh | sh
#
# Installs: Docker, Consul, Nomad, CNI plugins, then runs Postgres, Redis,
# Traefik and the nomploy app. Idempotent — safe to re-run.
#
# nomploy is a fork of Dokploy (Apache-2.0) that uses HashiCorp Nomad as the
# orchestrator. See https://github.com/Nomploy/nomploy.

set -e

NOMPLOY_IMAGE="${NOMPLOY_IMAGE:-ghcr.io/nomploy/nomploy:latest}"
NOMPLOY_PORT="${NOMPLOY_PORT:-3000}"
CNI_VERSION="${CNI_VERSION:-v1.5.1}"

# ── privilege + platform detection ─────────────────────────────────────────
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo"
  else
    echo "Error: run as root or with passwordless sudo." >&2
    exit 1
  fi
fi

if [ ! -f /etc/os-release ]; then
  echo "Error: unsupported OS (no /etc/os-release)." >&2
  exit 1
fi
OS_TYPE="$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) CNI_ARCH=amd64 ;;
  aarch64 | arm64) CNI_ARCH=arm64 ;;
  *) echo "Error: unsupported architecture $ARCH." >&2; exit 1 ;;
esac

echo "==> Installing nomploy on ${OS_TYPE} (${ARCH})"

# ── Docker ──────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker
else
  echo "Docker already installed."
fi

# ── Consul + Nomad (HashiCorp repos) ─────────────────────────────────────────
install_hashicorp_debian() {
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -y
  $SUDO apt-get install -y curl gnupg lsb-release
  curl -fsSL https://apt.releases.hashicorp.com/gpg \
    | $SUDO gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
    | $SUDO tee /etc/apt/sources.list.d/hashicorp.list >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y nomad consul
}

install_hashicorp_rhel() {
  $SUDO yum install -y yum-utils
  $SUDO yum-config-manager --add-repo https://rpm.releases.hashicorp.com/RHEL/hashicorp.repo
  $SUDO yum -y install nomad consul
}

if ! command -v nomad >/dev/null 2>&1 || ! command -v consul >/dev/null 2>&1; then
  echo "==> Installing Consul + Nomad"
  case "$OS_TYPE" in
    ubuntu | debian | raspbian | pop | linuxmint | zorin) install_hashicorp_debian ;;
    centos | rhel | rocky | almalinux | fedora | amzn | ol) install_hashicorp_rhel ;;
    *) echo "Error: unsupported OS $OS_TYPE for auto-install." >&2; exit 1 ;;
  esac
else
  echo "Consul + Nomad already installed."
fi

# ── CNI plugins (Nomad bridge networking) ────────────────────────────────────
if [ ! -f /opt/cni/bin/bridge ]; then
  echo "==> Installing CNI plugins"
  $SUDO mkdir -p /opt/cni/bin
  curl -fsSL "https://github.com/containernetworking/plugins/releases/download/${CNI_VERSION}/cni-plugins-linux-${CNI_ARCH}-${CNI_VERSION}.tgz" \
    | $SUDO tar -C /opt/cni/bin -xz
fi
echo 1 | $SUDO tee /proc/sys/net/bridge/bridge-nf-call-iptables >/dev/null 2>&1 || true

# ── Consul + Nomad config (single node: server + client) ─────────────────────
$SUDO mkdir -p /etc/consul.d /opt/consul /etc/nomad.d /opt/nomad

# ── WireGuard hub (cluster overlay 10.10.0.0/24) ─────────────────────────────
# The control plane is the WireGuard hub; Consul/Nomad servers bind to the hub's
# overlay IP so worker nodes can join over an encrypted mesh. Consul/Nomad HTTP
# APIs still answer on 127.0.0.1 for the local app. Endpoint workers dial defaults
# to this host's public IP (open UDP 51820); override with NOMPLOY_WG_ENDPOINT.
$SUDO mkdir -p /etc/nomploy
if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get install -y wireguard wireguard-tools >/dev/null 2>&1 || true
else
  $SUDO yum install -y wireguard-tools >/dev/null 2>&1 || true
fi
$SUDO mkdir -p /etc/wireguard && $SUDO chmod 700 /etc/wireguard
if [ ! -s /etc/wireguard/hub_priv ]; then
  $SUDO sh -c 'wg genkey > /etc/wireguard/hub_priv && chmod 600 /etc/wireguard/hub_priv && wg pubkey < /etc/wireguard/hub_priv > /etc/wireguard/hub_pub'
fi
HUB_PUB="$($SUDO cat /etc/wireguard/hub_pub)"
if [ ! -f /etc/wireguard/wg0.conf ]; then
  $SUDO tee /etc/wireguard/wg0.conf >/dev/null <<WGCONF
[Interface]
Address = 10.10.0.1/24
ListenPort = 51820
PrivateKey = $($SUDO cat /etc/wireguard/hub_priv)
PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT
WGCONF
  $SUDO chmod 600 /etc/wireguard/wg0.conf
fi
ip link show wg0 >/dev/null 2>&1 || $SUDO wg-quick up wg0 || true
$SUDO systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true

# Shared gossip encryption key (Consul + Nomad).
[ -s /etc/nomploy/gossip.key ] || consul keygen | $SUDO tee /etc/nomploy/gossip.key >/dev/null
GOSSIP="$($SUDO cat /etc/nomploy/gossip.key)"
WG_ENDPOINT="${NOMPLOY_WG_ENDPOINT:-$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}'):51820}"

$SUDO tee /etc/consul.d/consul.hcl >/dev/null <<CONSULHCL
data_dir    = "/opt/consul"
bind_addr   = "10.10.0.1"
client_addr = "0.0.0.0"
datacenter  = "dc1"
server           = true
bootstrap_expect = 1
encrypt = "$GOSSIP"
ui_config { enabled = true }
CONSULHCL

$SUDO tee /etc/nomad.d/nomad.hcl >/dev/null <<NOMADHCL
data_dir   = "/opt/nomad"
bind_addr  = "0.0.0.0"
datacenter = "dc1"

advertise {
  http = "10.10.0.1"
  rpc  = "10.10.0.1"
  serf = "10.10.0.1"
}

server {
  enabled          = true
  bootstrap_expect = 1
  encrypt          = "$GOSSIP"
}

client {
  enabled = true
  # Bind & register allocation ports on the WireGuard overlay so services are
  # reachable across the cluster (and never exposed on the public NIC). Keeps
  # Consul service addresses on 10.10.0.0/24, which Traefik routes to.
  network_interface = "wg0"
}

consul {
  address = "127.0.0.1:8500"
}

plugin "docker" {
  config {
    allow_privileged = true
    auth {
      config = "/root/.docker/config.json"
    }
  }
}
NOMADHCL

# Cluster descriptor read by the app to add worker nodes (nomad.joinCluster).
$SUDO tee /etc/nomploy/cluster.json >/dev/null <<CJSON
{
  "hubPublicKey": "$HUB_PUB",
  "gossipKey": "$GOSSIP",
  "hubWgIp": "10.10.0.1",
  "hubEndpoint": "$WG_ENDPOINT",
  "overlayCidr": "10.10.0.0/24",
  "peers": []
}
CJSON

# The Nomad docker plugin above sets auth.config = /root/.docker/config.json.
# If that file is missing, the docker driver fails to pull EVERY image (even
# public ones). Create an empty auth config so public pulls work; `docker login`
# later fills it in for private registries. Must exist before Nomad starts.
$SUDO mkdir -p /root/.docker
[ -s /root/.docker/config.json ] || echo '{"auths":{}}' | $SUDO tee /root/.docker/config.json >/dev/null

# Start via --no-block and poll the HTTP APIs for readiness. The packaged units
# are Type=notify; if the agent doesn't signal systemd, a blocking `restart`
# would hang and (under set -e) abort the install even though the agent is up.
wait_api() {
  name="$1"; url="$2"
  echo "==> Waiting for $name API"
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$name is up."
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  echo "Error: $name did not become ready in time." >&2
  return 1
}

echo "==> Starting Consul + Nomad"
# The packaged consul unit is Type=notify; on some builds the readiness signal
# never arrives, so systemd kills it at TimeoutStartSec and restart-loops. Track
# it by process liveness instead.
$SUDO mkdir -p /etc/systemd/system/consul.service.d
$SUDO tee /etc/systemd/system/consul.service.d/type.conf >/dev/null <<'CONSULUNIT'
[Service]
Type=exec
CONSULUNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable consul nomad >/dev/null 2>&1 || true
$SUDO systemctl restart --no-block consul
wait_api Consul "http://127.0.0.1:8500/v1/status/leader"
$SUDO systemctl restart --no-block nomad
wait_api Nomad "http://127.0.0.1:4646/v1/agent/health"

# ── Cluster DNS (dnsmasq) ───────────────────────────────────────────────────
# Nomad allocations point their DNS at the hub's WireGuard IP so they can resolve
# each other and their databases by name. dnsmasq (running as root, so it can bind
# :53) forwards *.service.consul to the local Consul DNS and everything else to a
# public resolver.
echo "==> Configuring cluster DNS (dnsmasq)"
$SUDO apt-get install -y dnsmasq >/dev/null 2>&1 || $SUDO yum -y install dnsmasq >/dev/null 2>&1 || true
$SUDO tee /etc/dnsmasq.d/nomploy-consul.conf >/dev/null <<'DNSMASQ'
bind-interfaces
listen-address=10.10.0.1
port=53
no-resolv
server=/consul/127.0.0.1#8600
server=1.1.1.1
server=8.8.8.8
DNSMASQ
$SUDO systemctl enable dnsmasq >/dev/null 2>&1 || true
$SUDO systemctl restart dnsmasq >/dev/null 2>&1 || true

# ── Datastores ────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-amukds4wi9001583845717ad2}"

run_container() {
  name="$1"; shift
  if [ "$($SUDO docker ps -q -f name="^${name}$" -f status=running)" ]; then
    echo "${name} already running."
    return
  fi
  $SUDO docker rm -f "$name" >/dev/null 2>&1 || true
  $SUDO docker run -d --name "$name" --restart unless-stopped "$@"
}

echo "==> Starting Postgres + Redis"
run_container nomploy-postgres \
  -e POSTGRES_USER=nomploy -e POSTGRES_DB=nomploy \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -v nomploy-postgres:/var/lib/postgresql/data \
  -p 127.0.0.1:5432:5432 postgres:16
run_container nomploy-redis \
  -v nomploy-redis:/data -p 127.0.0.1:6379:6379 redis:7

# ── Traefik (ingress via Consul Catalog) ─────────────────────────────────────
# Discovers deployed Nomad services from Consul (each carries traefik.* tags) and
# routes HTTP/HTTPS to them. Mirrors the app's initializeTraefikNomad().
TRAEFIK_DIR="/etc/nomploy/traefik"
$SUDO mkdir -p "$TRAEFIK_DIR/dynamic"
$SUDO tee "$TRAEFIK_DIR/traefik.yml" >/dev/null <<'TRAEFIKYML'
entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"

providers:
  consulCatalog:
    endpoint:
      address: "http://127.0.0.1:8500"
    exposedByDefault: false
    prefix: traefik
  # File provider: nomploy writes dynamic routes here (e.g. the panel's own
  # domain). Without this, setting a domain in the UI has no effect.
  file:
    directory: "/etc/nomploy/traefik/dynamic"
    watch: true

api:
  insecure: true
  dashboard: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@localhost
      storage: /etc/traefik/acme.json
      httpChallenge:
        entryPoint: web
TRAEFIKYML

if [ ! -f "$TRAEFIK_DIR/acme.json" ]; then
  $SUDO touch "$TRAEFIK_DIR/acme.json"
  $SUDO chmod 600 "$TRAEFIK_DIR/acme.json"
fi

echo "==> Starting Traefik"
run_container nomploy-traefik \
  --network host \
  --add-host nomploy:127.0.0.1 \
  -v "$TRAEFIK_DIR/traefik.yml:/etc/traefik/traefik.yml:ro" \
  -v "$TRAEFIK_DIR/acme.json:/etc/traefik/acme.json" \
  -v "$TRAEFIK_DIR/dynamic:/etc/nomploy/traefik/dynamic" \
  traefik:v3.0

# ── Nomad Autoscaler ─────────────────────────────────────────────────────────
# Reads scaling{} policies from Nomad jobs (emitted from compose x-nomad-scaling)
# and scales task groups via the nomad-apm metrics source.
echo "==> Starting Nomad Autoscaler"
run_container nomad-autoscaler \
  --network host \
  hashicorp/nomad-autoscaler:latest \
  agent -nomad-address=http://127.0.0.1:4646 -http-bind-address=127.0.0.1 -http-bind-port=8081

# Stable auth secret: generate once and persist, so sessions survive restarts
# (and we don't fall back to the insecure hardcoded default).
$SUDO mkdir -p /etc/nomploy
AUTH_SECRET_FILE=/etc/nomploy/auth-secret
if [ ! -s "$AUTH_SECRET_FILE" ]; then
  (openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n') \
    | $SUDO tee "$AUTH_SECRET_FILE" >/dev/null
  $SUDO chmod 600 "$AUTH_SECRET_FILE"
fi
BETTER_AUTH_SECRET="$($SUDO cat "$AUTH_SECRET_FILE")"

# ── nomploy app ───────────────────────────────────────────────────────────────
echo "==> Starting nomploy ($NOMPLOY_IMAGE)"
$SUDO docker pull "$NOMPLOY_IMAGE"
$SUDO docker rm -f nomploy >/dev/null 2>&1 || true
$SUDO docker run -d --name nomploy --restart unless-stopped \
  --network host \
  --cap-add NET_ADMIN \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /etc/nomploy:/etc/nomploy \
  -v /etc/wireguard:/etc/wireguard \
  -e NODE_ENV=production \
  -e PORT="$NOMPLOY_PORT" \
  -e DATABASE_URL="postgresql://nomploy:${POSTGRES_PASSWORD}@127.0.0.1:5432/nomploy" \
  -e REDIS_HOST="127.0.0.1" \
  -e BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  -e NOMAD_ADDRESS="http://127.0.0.1:4646" \
  -e CONSUL_ADDRESS="http://127.0.0.1:8500" \
  "$NOMPLOY_IMAGE"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "=============================================="
echo " nomploy is starting."
echo " Open:    http://${IP:-<server-ip>}:${NOMPLOY_PORT}"
echo " Ingress: Traefik on :80 / :443 (dashboard :8080)"
echo " Nomad:   http://${IP:-<server-ip>}:4646"
echo " Consul:  http://${IP:-<server-ip>}:8500"
echo "=============================================="
