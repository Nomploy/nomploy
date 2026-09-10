# Getting Started

This guide takes you from a bare Linux server to your first running app.

## 1. Requirements

- A fresh Linux VPS — Debian/Ubuntu or an RHEL-family distro.
- Root (or `sudo`) access over SSH.
- A public IP. For HTTPS you'll also want a domain you can point at that IP.
- Recommended minimum: 2 vCPU / 4 GB RAM for the first node (it runs the panel,
  Postgres, Redis, Traefik **and** the Nomad/Consul server).

> nomploy installs and manages Docker, Consul, Nomad and the CNI plugins for you.
> You don't need to install an orchestrator beforehand.

## 2. Install

On the server, run:

```bash
curl -sSL https://raw.githubusercontent.com/Nomploy/nomploy/main/install.sh | sh
```

This installs Docker, Consul, Nomad, the CNI plugins, Traefik, Postgres, Redis
and the nomploy panel (which itself runs as a Nomad job), then prints the URL to
open — `http://<your-server-ip>:3000`.

> **Private image?** The panel image is published to `ghcr.io/nomploy/nomploy`.
> If the package is private, either make it public in its GitHub package settings
> or run `docker login ghcr.io` on the server before installing. Override the
> image entirely with `NOMPLOY_IMAGE=…`.

This first node becomes your **control plane**: it hosts the panel and its
database, and runs the Nomad/Consul server that schedules everything. See
[Architecture](architecture.md) for how the pieces fit together.

## 3. First login

1. Open `http://<your-server-ip>:3000`.
2. Create the first admin account (this becomes the organization owner).
3. You land on the dashboard.

### Point a domain at the panel (optional but recommended)

To reach the panel over HTTPS at your own domain, create an `A` record pointing
your domain at the server IP, then set the panel domain in
**Settings → Server / Domains**. Traefik requests a Let's Encrypt certificate
automatically.

## 4. Deploy your first app

1. Create a **Project**, then add an **Application** to it.
2. Choose a source — a Git repo (GitHub/GitLab/Bitbucket/Gitea or a plain Git
   URL), or a Docker image.
3. Set the build type if you're building from source (Nixpacks, a Dockerfile,
   etc.), then add any environment variables.
4. Add a **Domain** for the app if it serves HTTP — Traefik routes it through the
   Consul Catalog and issues TLS automatically.
5. Click **Deploy**. The app is translated to a Nomad job and scheduled; watch
   the deployment logs stream live.

For Docker Compose, native Nomad job files, and Nomad Pack, see
**[Deploying](deploying.md)**.

## 5. Grow the cluster (optional)

A single node is a scheduling single point of failure. When you're ready for
high availability or more capacity, add more nodes from the **Cluster** tab — see
**[Cluster management](cluster.md)**.

## Next steps

- [Deploying](deploying.md) — compose, native HCL, and Nomad Pack.
- [Autoscaling](autoscaling.md) — scale apps and services on CPU/memory.
- [Container registry](registry.md) — register your own registry for build → push → pull across nodes.
- [Cluster management](cluster.md) — high availability and capacity.
