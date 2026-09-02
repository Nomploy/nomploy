# Adding worker nodes (multi-node cluster)

nomploy runs a HashiCorp **Nomad** cluster. The machine created by `install.sh`
is the **control plane** (a Nomad server + client, Consul server, Traefik, the
panel). You add capacity by joining **worker** nodes to it from the UI — no
manual SSH bootstrap needed.

Nodes are connected by a **WireGuard mesh** (overlay `10.10.0.0/24`): the control
plane is the hub (`10.10.0.1`) and each worker dials in as a spoke. All Nomad and
Consul traffic between nodes rides inside that encrypted tunnel, so you never have
to expose Nomad/Consul ports publicly.

## Add a worker from the UI

1. **Settings → Remote Servers → Create Server.** Enter the worker's name, its
   IP, SSH port and user (`root` or a user with passwordless sudo), and pick an
   SSH key. The control plane must be able to reach this IP over SSH — see
   *Network requirements* below.
2. On the new server's card open the **…** menu → **Nomad**.
3. Click **Join cluster.** nomploy will, over SSH:
   - allocate the next free overlay IP (`10.10.0.2`, `10.10.0.3`, …),
   - install Docker + Consul + Nomad + CNI + WireGuard on the worker,
   - bring up the worker's `wg0` and register it as a WireGuard peer on the hub,
   - start the Consul + Nomad clients and join them to the control plane.

   The log streams live; on success the node appears under **Nomad → Nodes** as
   `ready` within a few seconds.

That's it — Nomad now schedules workloads across every node. A service with more
than one replica is spread across distinct nodes automatically.

## Network requirements

The **control plane must reach each worker over SSH** (TCP `22`, or your custom
port) to run the join, and the **worker must reach the control plane over
WireGuard** (UDP `51820`) to form the overlay. Everything else (Nomad `4646-4648`,
Consul `8300-8302/8500/8600`) travels inside the WireGuard tunnel and needs no
public exposure.

If your provider puts a **cloud firewall** in front of the machines (Hetzner
Cloud Firewall, AWS Security Group, …), a freshly-provisioned worker often only
allows SSH from *your own* IP. The control plane's IP is then blocked and
**Join cluster** fails with `Timed out while waiting for handshake` (the TCP SYN
is silently dropped upstream — ICMP/ping may still work). Two clean fixes:

- **Open the firewall:** allow inbound `TCP/22` and `UDP/51820` from the control
  plane's IP (`/32`) on the worker.
- **Use a private network (recommended):** if both machines share a private
  network (e.g. a Hetzner private network, `10.x`), set the worker's *IP* in
  nomploy to its **private address**. The control plane reaches it there with no
  public exposure and no firewall changes — provider private networks are open
  between attached servers by default.

> The **Join cluster** log names the exact ports and the control-plane IP when a
> connection can't be opened, so you always know what to allow.

## Removing / re-joining a worker

Re-joining a torn-down worker registers a fresh Nomad node ID, leaving the old
one as `down`. Nomad garbage-collects those automatically; to clear them
immediately run `nomad system gc` on the control plane.
