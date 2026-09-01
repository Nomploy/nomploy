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

$SUDO tee /etc/consul.d/consul.hcl >/dev/null <<'CONSULHCL'
data_dir    = "/opt/consul"
bind_addr   = "{{ GetPrivateIP }}"
client_addr = "0.0.0.0"
datacenter  = "dc1"
server           = true
bootstrap_expect = 1
ui_config { enabled = true }
CONSULHCL

$SUDO tee /etc/nomad.d/nomad.hcl >/dev/null <<'NOMADHCL'
data_dir   = "/opt/nomad"
bind_addr  = "0.0.0.0"
datacenter = "dc1"

server {
  enabled          = true
  bootstrap_expect = 1
}

client {
  enabled = true
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

echo "==> Starting Consul + Nomad"
$SUDO systemctl enable consul nomad
$SUDO systemctl restart consul
sleep 3
$SUDO systemctl restart nomad

echo "==> Waiting for Nomad API"
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS http://127.0.0.1:4646/v1/agent/health >/dev/null 2>&1; then
    echo "Nomad is up."
    break
  fi
  i=$((i + 1))
  sleep 2
done

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
  -v "$TRAEFIK_DIR/traefik.yml:/etc/traefik/traefik.yml:ro" \
  -v "$TRAEFIK_DIR/acme.json:/etc/traefik/acme.json" \
  -v "$TRAEFIK_DIR/dynamic:/etc/nomploy/traefik/dynamic" \
  traefik:v3.0

# ── nomploy app ───────────────────────────────────────────────────────────────
echo "==> Starting nomploy ($NOMPLOY_IMAGE)"
$SUDO docker pull "$NOMPLOY_IMAGE"
$SUDO docker rm -f nomploy >/dev/null 2>&1 || true
$SUDO docker run -d --name nomploy --restart unless-stopped \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /etc/nomploy:/etc/nomploy \
  -e NODE_ENV=production \
  -e PORT="$NOMPLOY_PORT" \
  -e DATABASE_URL="postgresql://nomploy:${POSTGRES_PASSWORD}@127.0.0.1:5432/nomploy" \
  -e REDIS_URL="redis://127.0.0.1:6379" \
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
