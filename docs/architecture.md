# Architecture

nomploy is a control panel on top of a **HashiCorp Nomad + Consul** cluster. This
page explains the moving parts so the rest of the docs make sense.

## The pieces

| Component | Role |
|---|---|
| **Nomad** | Schedules and runs every workload as a *job* (the panel, your apps, databases, compose services, the built-in registry). |
| **Consul** | Service discovery + health, and the source Traefik reads routes from (Consul Catalog). |
| **Traefik** | Edge router. Services register in Consul with Traefik tags and are routed automatically, with Let's Encrypt TLS. |
| **Postgres + Redis** | The panel's own state and queues. Single-node, on the control plane. |
| **WireGuard** | An encrypted overlay network (`10.10.0.0/24`) that ties all nodes together regardless of where they live. |
| **The panel** | nomploy itself — runs as a Nomad job, so it can update itself. |

## Control plane vs. workers

The **first node you install is the control plane** (the "hub"). It carries:

- the nomploy panel and its Postgres/Redis,
- Traefik,
- a Nomad **server** + Consul **server** (the schedulers),
- and a Nomad **client**, so it can run workloads too.

The control plane is marked with the Nomad node meta
`nomploy_control_plane = "true"`. The panel job hard-constrains itself to that
meta, so **the panel only ever runs on the control plane** (it needs the local
database). Worker nodes deliberately omit that meta.

**Workers** you add later run a Nomad + Consul **client** only — they run your
workloads but never the panel or the DB.

For high availability you add more **servers** (up to 3) so scheduling survives a
node failure. See [Cluster management](cluster.md).

## The WireGuard overlay

Every node joins a WireGuard mesh on `10.10.0.0/24`:

- **`.1`** — the hub (control plane), permanent.
- **`.1`–`.10`** — servers.
- **`.11`+** — workers.

Nomad and Consul bind to the overlay interface (`wg0`), so cluster traffic is
encrypted and works across clouds/regions without exposing Nomad/Consul ports to
the public internet. Workers peer **all** servers directly, so if the hub goes
down a worker still reaches a surviving server and keeps scheduling.

### Cluster DNS

Each server runs a small DNS resolver so allocations can resolve Consul service
names (`<service>.service.consul`). Allocations are handed the server IPs as
their DNS servers, and the **Cluster** tab surfaces a DNS-health check across
nodes so you can spot a resolver that has drifted.

## The deploy artifact

Whatever you deploy ends up as a **Nomad job**:

- **Applications** and **databases** are rendered to a Nomad jobspec from your
  settings (image, env, ports, health checks, resources, replicas, autoscaling).
- **Docker Compose** files are translated to an equivalent Nomad job.
- You can also hand nomploy a **native Nomad HCL job file** and it deploys it
  verbatim, or point it at a **Nomad Pack**.

See [Deploying](deploying.md) for all three paths.

## Self-updating panel

Because the panel is itself a Nomad job (`nomploy`), the **Reload/Update** action
re-submits that job with `force_pull`, which pulls the newest panel image and
does a rolling, health-gated, auto-reverting redeploy — the Nomad equivalent of
`docker service update --image`. "Update available" is detected by comparing the
running image's digest against the tag's current digest in the registry.

## What is *not* HA (yet)

High availability here means the **scheduler / control plane** (Nomad + Consul
servers) keeps scheduling if a server dies. The **panel and its Postgres/Redis
stay single-node** on the original hub. A highly-available panel/database is a
separate, later effort.
