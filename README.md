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
- **Nomad dashboard** — view jobs, allocations, nodes, logs and cluster
  resources; scale or stop jobs from the UI. Pick which server's Nomad cluster to
  view with a per-server selector.
- **One-click Nomad bootstrap** — install Docker + Consul + Nomad + CNI on a
  managed server over SSH, straight from the UI.
- **Applications & databases** — Node.js, PHP, Python, Go, Ruby, …; MySQL,
  PostgreSQL, MongoDB, MariaDB, libSQL and Redis.
- **Ingress via Traefik + Consul Catalog** — services register in Consul with
  Traefik tags and are routed automatically, with Let's Encrypt TLS.
- **Docker Compose**, **templates**, **backups** (S3), **multi-server**,
  **real-time monitoring**, **notifications** (Slack/Discord/Telegram/email),
  and a **tRPC API**.
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

## 🧭 How nomploy differs from Dokploy

| | Dokploy | nomploy |
|---|---|---|
| Orchestrator | Docker Swarm | HashiCorp Nomad |
| Service discovery / ingress | Traefik (Docker provider) | Traefik + Consul Catalog |
| Deploy artifact | Swarm stack / compose | Nomad HCL job (from compose) |
| Enterprise modules (SSO, audit, custom roles, white-label) | Source-available add-on | Removed; free-tier equivalents |

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
