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

# Single-node all-in-one: bind everything to 127.0.0.1. This avoids the
# multiple-private-IP ambiguity ({{ GetPrivateIP }} can pick the docker bridge)
# and keeps Nomad/Consul internal — only Traefik is exposed publicly.
$SUDO tee /etc/consul.d/consul.hcl >/dev/null <<'CONSULHCL'
data_dir    = "/opt/consul"
bind_addr   = "127.0.0.1"
client_addr = "127.0.0.1"
datacenter  = "dc1"
server           = true
bootstrap_expect = 1
ui_config { enabled = true }
CONSULHCL

$SUDO tee /etc/nomad.d/nomad.hcl >/dev/null <<'NOMADHCL'
data_dir   = "/opt/nomad"
bind_addr  = "127.0.0.1"
datacenter = "dc1"

# Explicit advertise: Nomad refuses to default a server's advertise to localhost.
advertise {
  http = "127.0.0.1"
  rpc  = "127.0.0.1"
  serf = "127.0.0.1"
}

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
$SUDO systemctl enable consul nomad >/dev/null 2>&1 || true
$SUDO systemctl restart --no-block consul
wait_api Consul "http://127.0.0.1:8500/v1/status/leader"
$SUDO systemctl restart --no-block nomad
wait_api Nomad "http://127.0.0.1:4646/v1/agent/health"

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
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /etc/nomploy:/etc/nomploy \
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
