# Cluster management

A single node schedules everything from one machine — if it dies, nothing runs.
The **Cluster** tab lets you grow into a highly-available, multi-node cluster:
add servers and workers, drain nodes for maintenance, and remove them cleanly.

> The Nomad dashboard (including this tab) is only available on self-hosted
> installs, not on nomploy cloud.

## Where it lives

**Dashboard → Nomad → Cluster** tab. A selector at the top picks which cluster to
view (`Local (control plane)` or a registered server). The Cluster tab also
exposes **Jobs**, **Nodes**, **Consul**, **Network**, **Autoscaling** and
**Logs** alongside it.

## Servers vs. workers

Two node roles make up a cluster:

- **Server** — runs a Nomad + Consul server (part of the raft that schedules
  work). Servers give you high availability.
- **Worker** — runs a Nomad + Consul client only. Workers add capacity to run
  your workloads; they never join the raft.

The first node you installed is the **control plane** — a server that also hosts
the panel and its database. See [Architecture](architecture.md).

## High-availability status

The top of the tab shows whether the cluster is **Highly available** or
**Not highly available**, with four tiles:

- **Servers** — the raft members.
- **Workers** — nodes that run workloads.
- **Fault tolerance** — how many servers can fail, computed as
  `floor((servers − 1) / 2)`.
- **Raft leader** — the current leader.

The cluster is HA once you have **≥ 3 servers** (fault tolerance ≥ 1). Below that,
a **"Add N server(s) for HA"** button provisions the servers you're missing.

## Adding a node

There are two ways to add a node.

### One-click cloud — "Add node"

The **Add node** dropdown provisions a fresh cloud VM and joins it automatically:

- **Add worker node** — more capacity for workloads.
- **Add server node** — grows the HA raft.

This requires the cluster **autoscaler** to be configured first — it needs a
cloud-provider **token** and an **SSH key**. Set those under **Nomad →
Autoscaling**. Until then, the button is disabled with a hint pointing you there.
(Provisioning uses the same provider config the node autoscaler uses.)

### Bring-your-own — "Add existing server"

If you've already registered a server in nomploy (Settings → Servers), use
**Add existing server** to install and join it in one step — no cloud provider
needed. In the dialog:

1. **Server** — pick a registered server that isn't already in a cluster.
2. **Role** — *Worker — runs workloads* or *Server — grows the HA raft*.
3. **Join cluster**.

nomploy installs Docker/Consul/Nomad/WireGuard on the node and joins it over the
mesh, streaming the logs live. It runs an SSH/sudo preflight first; if key auth
fails, the log prints the exact `authorized_keys` command to run on the node.

> **Firewall:** each node must allow inbound `TCP/<ssh port>` and `UDP/51820`
> (WireGuard) from the control-plane IP — see [Network requirements](#network-requirements).

## The members table

Each member is listed with **Name**, **Role**, **Source**, **Overlay IP**,
**Status** and **Actions**. The **Source** column tells you how a node was added:

| Source | Meaning |
|---|---|
| **control plane** | The panel + database host (the original hub). |
| **autoscaled** | Provisioned by the node autoscaler. |
| **cloud** | A one-click cloud VM. |
| **manual** | Added by hand over SSH. |

Status reflects the live Nomad node state (`ready`, `draining`, `cordoned`, …).
The current raft leader is badged. The control-plane row has no actions here — it
can't be drained or removed from this tab.

## Drain / maintenance mode

From a node's row actions, **Drain (maintenance)** cordons the node and migrates
its allocations off (a 5-minute deadline), marking it ineligible for new work —
use it before rebooting or resizing a node. **Resume (un-drain)** re-enables
scheduling. The control plane is never a drain target.

## Removing a node

**Remove from cluster** (row actions) drains the node, stops its services,
removes its WireGuard peer from every remaining member, and wipes its
Nomad/Consul data. If the node is a **cloud VM**, it's permanently destroyed so
it stops billing.

Guardrails:

- The **last remaining server** can't be removed.
- Removing a server that would drop you **below 3 servers** requires ticking
  **Force (drop below 3 servers)** — you'll lose HA.

## Network requirements

For a join to succeed:

- The **control plane must reach the new node over SSH** (TCP `22`, or your
  custom port) to run the install.
- The **node must reach the servers over WireGuard** (UDP `51820`) to form the
  overlay.

Everything else — Nomad (`4646`–`4648`) and Consul (`8300`–`8302`, `8500`,
`8600`) — travels inside the WireGuard tunnel and needs no public exposure.

If your provider puts a **cloud firewall** in front of the machines (Hetzner
Cloud Firewall, AWS Security Group, …), a freshly-provisioned node often only
allows SSH from *your own* IP, so the control plane's IP is blocked and the join
fails with `Timed out while waiting for handshake` (the TCP SYN is dropped
upstream; ping may still work). Two clean fixes:

- **Open the firewall** — allow inbound `TCP/<ssh port>` and `UDP/51820` from the
  control plane's IP (`/32`) on the node.
- **Use a private network (recommended)** — if both machines share a private
  network (e.g. a Hetzner private network, `10.x`), register the node in nomploy
  with its **private address**. The control plane reaches it there with no public
  exposure and no firewall changes.

> The join log names the exact ports and the control-plane IP when a connection
> can't be opened, so you always know what to allow.

## Cluster DNS health

A **Cluster DNS** strip shows `{n}/{m} resolvers healthy` with a colored dot per
server (it re-checks every 30s). Each server runs a resolver so allocations can
look up Consul service names; a down dot means that server won't serve DNS
failover. A server that joined **before** HA DNS was introduced may need its
`dnsmasq` backfilled — the strip calls this out when it detects it.

## The WireGuard overlay (reference)

Membership and the mesh are tracked in `/etc/nomploy/cluster.json` on the control
plane (hub keys, gossip key, overlay CIDR, servers, worker peers). Overlay
addressing on `10.10.0.0/24`: the hub is `.1`, servers take `.1`–`.10`, workers
`.11`+. Peers dial each other on `:51820`. See [Architecture](architecture.md)
for the reachability model.
