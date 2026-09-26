# nomploy

**nomploy** is a free, self-hostable Platform as a Service (PaaS) that deploys and
manages your applications and databases on a **[HashiCorp Nomad](https://www.nomadproject.io/)**
cluster.

It is a fork of [Dokploy](https://github.com/dokploy/dokploy) that swaps the
orchestrator from Docker Swarm to Nomad, while keeping Dokploy's UI, git
integration, domains/SSL, backups, monitoring and notifications. nomploy as a
whole is licensed under the **GNU AGPL-3.0**; the upstream enterprise
(source-available) modules are **not** included — see
[Attribution & License](#-attribution--license).

## ✨ Features

- **Nomad orchestration** — deploys run as Nomad jobs; the compose files you
  already know are translated to Nomad HCL (ports, env, health checks, resources,
  replicas and autoscaling via `x-nomad-scaling`).
- **Three ways to deploy** — translated Docker Compose, a **native Nomad HCL job
  file** deployed verbatim, or a **Nomad Pack** from a custom registry or the
  **hosted pack registry at [`packs.nomploy.com`](https://packs.nomploy.com)**.
- **Highly-available clusters** — grow from one node to an HA Nomad + Consul
  control plane from the **Cluster** tab: add/remove servers and workers over an
  encrypted WireGuard mesh, drain nodes for maintenance, upgrade Nomad (including
  the control plane) from the UI, see each node's private IP, and watch cluster
  DNS health.
- **Cluster autoscaling with node-pool groups** — ASG-style **autoscaling
  groups**, each backed by its own **Nomad node pool** and launch template (cloud
  provider, server type, region, image, SSH key, min/max, CPU/memory reservation
  thresholds and cooldown). Each group scales **independently** on its pool's
  pressure; target a group from a job's `node_pool`. Supports reactive scaling, a
  manual **desired count** and **scheduled** actions (cron), and it provisions,
  joins, drains and destroys cloud VMs automatically — without removing a node
  whose pool still has running work.
- **Cloud providers** — register a cloud credential once (e.g. Hetzner) in
  **Settings → Cloud** and reference it from any autoscaling group or the
  one-click **Add node** action; tokens never live on individual groups.
- **App & service autoscaling** — horizontal autoscaling on CPU/memory targets for
  applications and compose services.
- **Runtime secrets & config files** — per application or compose, store secret
  environment variables and whole config files in **Nomad Variables**; they are
  injected as env or mounted as files at runtime and **never appear in the job
  spec**.
- **Bring-your-own registry** — register any OCI registry (your own zot/`registry:2`,
  GHCR, ECR, …) in **Settings → Registry**; credentials are distributed to every
  node via Consul KV + consul-template, so private images pull cluster-wide with
  no credentials in job specs.
- **GPU workloads** — request NVIDIA GPUs for a job via Nomad device plugins.
- **Nomad dashboard** — view jobs, allocations, nodes, logs and cluster
  resources; scale or stop jobs and **exec into an allocation's task** from the
  UI. Pick which server's Nomad cluster to view with a per-server selector.
- **One-click Nomad bootstrap** — install Docker + Consul + Nomad + CNI on a
  managed server over SSH, straight from the UI.
- **Applications & databases** — Node.js, PHP, Python, Go, Ruby, …; MySQL,
  PostgreSQL (incl. **pgvector**), MongoDB, MariaDB, libSQL and Redis, persisted on
  real Nomad-managed Docker volumes.
- **Ingress via Traefik + Consul Catalog** — services register in Consul with
  Traefik tags and are routed automatically, with Let's Encrypt TLS.
- **High-availability ingress ("Load Balancer")** — run an **active/active Traefik
  pool** on every node tagged `nomploy_lb` (the hub is excluded) from the **Load
  Balancer** tab. The pool serves every route from the Consul catalog and shares
  TLS certs through Consul KV (auto-resynced from the hub as they renew). It gets a
  **generated DNS hostname** whose A records are health-pruned to the healthy
  nodes' public IPs (Cloudflare, AWS-ALB style — CNAME your app domains to it), and
  the tab has **time-range throughput/latency graphs** (2xx/4xx/5xx, Prometheus),
  **consolidated searchable logs tagged by instance**, and per-cert expiry.
- **DNS providers (Cloudflare)** — register a DNS credential in **Settings → DNS
  Providers**; used for ACME **DNS-01** (as an additional resolver, HTTP-01 stays
  the default) and to manage the Load Balancer's records.
- **Live metrics & scaling suggestions** — telemetry-based CPU/memory per project,
  environment and service, shown as **used-vs-reserved** with sparklines, plus
  utilization/right-sizing **suggestions** and an optional **daily digest**.
- **Backups & restore** — scheduled backups of managed databases (PostgreSQL,
  MySQL, MariaDB, MongoDB, libSQL) and the panel's own database to any
  **S3-compatible** store (AWS S3, **Cloudflare R2**, …), with per-backup last-run
  health and one-command restore.
- **Docker Compose**, **templates**, **multi-server**, **real-time monitoring**,
  **notifications** (Slack/Discord/Telegram/email), and a **tRPC API**.
- **Self-hosted** — runs on your own VPS.

## 🚀 Getting Started

On a fresh Linux VPS (Debian/Ubuntu or RHEL family), run:

```bash
curl -sSL https://raw.githubusercontent.com/Nomploy/nomploy/main/install.sh | sh
```

This installs Docker, Consul, Nomad, the CNI plugins, Traefik, Postgres, Redis
and the nomploy app, then prints the URL to open.

> The app image is published to `ghcr.io/nomploy/nomploy`. If the container
> package is private, either make it public in its GitHub package settings or run
> `docker login ghcr.io` on the server before installing. Override the image with
> `NOMPLOY_IMAGE=…` if needed.

To add Nomad to an **existing** managed server instead, use the **Bootstrap
Nomad** button in that server's Nomad settings inside the dashboard.

## 📚 Documentation

Full guides live in [`docs/`](docs/README.md):

- [Getting Started](docs/getting-started.md) — install, first login, first deploy.
- [Architecture](docs/architecture.md) — Nomad, Consul, Traefik and the WireGuard overlay.
- [Cluster management](docs/cluster.md) — high availability: add/remove nodes, drain, DNS health.
- [Deploying](docs/deploying.md) — Compose, native Nomad HCL, and Nomad Pack
  (custom registries or the hosted registry at `packs.nomploy.com`).
- [Autoscaling](docs/autoscaling.md) — scale apps and services on CPU/memory, and
  the cluster itself with node-pool autoscaling groups.
- [Load Balancer](docs/load-balancer.md) — HA Traefik pool, DNS health-prune,
  shared certs, and the metrics/logs tabs.
- [Container registry](docs/registry.md) — bring-your-own registry + cluster-wide auth.
- [GPU workloads](docs/gpu.md) — requesting NVIDIA GPUs.

## 🧭 How nomploy differs from Dokploy

| | Dokploy | nomploy |
|---|---|---|
| Orchestrator | Docker Swarm | HashiCorp Nomad |
| Service discovery / ingress | Traefik (Docker provider) | Traefik + Consul Catalog |
| Deploy artifact | Swarm stack / compose | Nomad HCL job (from compose), native HCL, or Nomad Pack |
| Cluster / node autoscaling | — | ASG-style autoscaling groups on Nomad node pools |
| Ingress HA | Single Traefik | Active/active Traefik pool + DNS health-prune, shared certs via Consul KV |
| Secrets & config files | Plaintext env in the stack | Nomad Variables, kept out of the job spec |
| Pack registry | — | Hosted at `packs.nomploy.com`, plus any custom registry |
| Enterprise modules (SSO, audit, custom roles, white-label) | Source-available add-on | Removed; free-tier equivalents |

### Swarm → Nomad migration status

The Docker Swarm backend has been removed from every runtime path:

- **Deploys, reloads, stop/start, scaling and rollbacks** for applications,
  databases and compose services run as Nomad jobs (`nomad job run` / `scale` /
  `stop -purge`).
- **Logs, exec/terminal, volume & database backups, restores, scheduled tasks
  and container monitoring** resolve a service's container through its Nomad
  allocation (the `com.hashicorp.nomad.alloc_id` label), not Swarm services.
- **The panel updates itself** — the UI's *Reload/Update* re-submits nomploy's
  own Nomad job (the Nomad equivalent of Swarm's `docker service update
  --image`), and *update available* is detected from the GHCR image digest.
- **Traefik** routes via the Consul Catalog provider on host networking, and the
  dashboard is toggled through `api.insecure` in `traefik.yml`.
- **Adding a server** provisions a Nomad worker over the WireGuard mesh, not a
  Swarm node; server setup/validation no longer touch `docker swarm` or the
  overlay network.

Cleanup of Swarm-era remnants is largely done: the unused `*Swarm` DB columns
have been dropped, and GPU scheduling now uses Nomad device plugins rather than
node labels. The `stack` compose type remains in the schema enum for backward
compatibility but is unused and unreachable.

## 🤝 Contributing

See the [Contributing Guide](CONTRIBUTING.md).

## 📝 Attribution & License

nomploy is a fork of **Dokploy** — Copyright © Dokploy Technology, Inc.
Original project: https://github.com/dokploy/dokploy

nomploy as a whole is licensed under the **GNU AGPL-3.0** (see [`LICENSE`](LICENSE)).
Portions derived from Dokploy remain under **Apache-2.0** (see
[`LICENSE-APACHE`](LICENSE-APACHE)); that grant is preserved and Dokploy's
notices are retained. Apache-2.0 permits redistributing a modified work under a
compatible copyleft license such as the AGPL — see [`LICENSING.md`](LICENSING.md)
for how the two fit together.

Upstream Dokploy was dual-licensed: most code under Apache-2.0, plus enterprise
modules under the separate Dokploy Source Available License (DSAL) in
`/proprietary` directories. nomploy does **not** ship any DSAL-licensed code —
those modules were removed and replaced with original implementations. Full
details and attribution are in the [`NOTICE`](NOTICE) file.

Contributions are accepted under the [Contributor License Agreement](CLA.md),
which keeps a commercial-licensing option open alongside the AGPL.
