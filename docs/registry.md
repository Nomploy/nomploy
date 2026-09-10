# Container registry

nomploy has **no built-in registry**. You run your own OCI registry (as a normal
service) and register it in **Settings → Registry → Add Registry**. This keeps the
registry decoupled and replaceable, and it works with any registry — your own zot,
a plain `registry:2`, GHCR, ECR, Docker Hub, etc.

## Do you even need one?

Only for **build-from-source on a multi-node cluster**. The image is built on one
node but Nomad may schedule the workload on any node, so a built image has to be
pullable from somewhere every node can reach.

You can skip a registry entirely when:
- **Single-node** — build and run on the same box (local image store is enough).
- **You only run pre-built images** (templates like `postgres`, `redis`, or
  `image: ghcr.io/you/app`) — every node pulls from the public source directly.

## Run a registry (zot) via the pack

The quickest internal option is the **zot** pack from
[`Nomploy/nomad-packs`](https://github.com/Nomploy/nomad-packs):

```bash
nomad-pack registry add nomploy github.com/Nomploy/nomad-packs
# anonymous pull + authenticated push (recommended for an internal registry):
#   htpasswd -bnBC10 pushuser 'a-strong-pass'
nomad-pack run zot --registry nomploy \
  --var 'htpasswd=pushuser:$2y$10$...' \
  --var 'constraints=[{attribute="${meta.nomploy_control_plane}",operator="=",value="true"}]'
```

Or in nomploy: a **Compose** service, type **Nomad Pack**, pack `zot`, custom
registry `github.com/Nomploy/nomad-packs`. It comes up host-networked at
`<node-ip>:5000` with anonymous pull / authenticated push. (You can equally run
any other registry as a normal Docker service.)

## Make the cluster trust + use it

Two things every node needs, and how nomploy handles them:

1. **Trust (TLS).** An HTTP registry needs `<addr>` in each node's Docker
   `insecure-registries` (`/etc/docker/daemon.json` + `systemctl reload docker`).
   This is a per-node **daemon** setting — there's no per-job way around it.
   A registry with a real HTTPS cert removes this step entirely.
2. **Auth (credentials).** Handled for you: **Add Registry** publishes the merged
   docker auth to **Consul KV**, and **consul-template** on every node renders it
   to `/root/.docker/config.json` (installed on join + by `install.sh`, refreshed
   when you change a registry). So private images pull cluster-wide **without any
   credentials in job specs** — the Nomad equivalent of Swarm's
   `--with-registry-auth`.

> Consul KV is plaintext, gated only by Consul ACLs — fine for a single-tenant
> private (WireGuard) cluster; use Vault for a shared/multi-tenant one.

## Add Registry

**Settings → Registry → Add Registry:**
- **Registry URL** — e.g. `10.10.0.1:5000` (or your registry's host)
- **Username / Password** — the push credentials (self-hosted registries can be
  anonymous-pull, so only push needs them)
- **Image prefix** — e.g. `apps`

Then build & deploy: nomploy pushes to `<registry>/<prefix>/<image>` from the
control plane, and every node pulls it.
