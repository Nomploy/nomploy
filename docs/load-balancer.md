# Load Balancer (HA ingress)

nomploy's default ingress is a single Traefik on the hub. The **Load Balancer**
tab turns that into a **highly-available, active/active Traefik pool** running on
every node you tag, with DNS-based failover and its own metrics and logs.

Open it from the sidebar (**Load Balancer**). It has three tabs: **Overview**,
**Metrics**, and **Logs**.

## How it works

- **Pool** — a Nomad `system` job (`nomploy-traefik-ha`) runs one Traefik per node
  whose Nomad meta has `nomploy_lb = "true"`. The hub is deliberately **excluded**
  (it keeps the standalone Traefik), so standing the pool up never clashes on
  `:80/:443` there and causes no downtime.
- **Routing** — each instance reads routes from the local Consul catalog, exactly
  like the hub, so every app/domain is served by every instance.
- **Certificates** — TLS certs are shared through **Consul KV** (Traefik's `consul`
  KV provider). Deploying the pool seeds the current certs from the hub's
  `acme.json`; a background loop **re-syncs every 6h** so renewals propagate. The
  Pool card lists each served domain with a **days-left** badge.
- **Entry / failover (DNS)** — the pool gets a **generated hostname**
  (`lb-<random>.<zone>`) whose **A records are kept equal to the healthy nodes'
  public IPs** (health-prune). Point your app domains at the pool by adding a
  **CNAME** to that hostname. Failover is DNS-speed (records use a 60s TTL).

## 1. Tag the pool nodes

Give each node you want in the pool the `nomploy_lb` meta:

```bash
nomad node meta apply -node-id=<node-id> nomploy_lb=true
```

Leave the hub untagged. (A node-tagging UI is on the roadmap.)

## 2. Deploy the pool

**Load Balancer → Overview → Deploy.** This seeds the certs into Consul KV and
runs the system job on every tagged node. The member list shows each instance,
its public IP, and status. Use **Sync certs** to force a cert re-seed, or **Stop**
to remove the pool (the hub keeps serving).

## 3. Configure DNS (optional but recommended)

Requires a DNS provider in **Settings → DNS Providers** (Cloudflare).

On the **Overview → DNS** card:

1. Pick the DNS provider and zone, then **Generate hostname**.
2. Flip **Manage DNS** on. The controller creates A records for the hostname
   pointing at the healthy nodes and keeps them pruned (a 30s loop, plus
   **Reconcile now**).
3. **CNAME** your app domains to the generated hostname — the pool already serves
   their routes and certs.

> If your zone has a proxied wildcard (`*.example.com`), the explicit A records
> nomploy creates are more specific and take precedence, so the hostname resolves
> straight to your nodes.

## Metrics

The **Metrics** tab shows pool-wide **throughput** (requests/s split by
2xx/4xx/5xx) and **average latency**, over a selectable range (**1h / 6h / 24h /
7d**), plus a live per-instance table (rate, status classes, latency, health,
in-DNS). Data comes from Traefik's Prometheus endpoint, sampled every 60s into a
rolling 7-day series.

## Logs

The **Logs** tab shows **consolidated** Traefik logs across the whole pool, each
line **tagged with the instance** it came from. The access log is parsed into a
searchable, color-coded table (time, instance, status, method, host/path,
duration, client); switch to **Errors** for the app log. Filter with the search
box, **4xx/5xx only**, or **Pause** the 5s auto-refresh.

## Notes & limits

- After enabling metrics/logs for the first time, **Redeploy** the pool so it
  exposes the Prometheus `:8082` entrypoint and the access-log config.
- Public IPs are auto-detected from the Hetzner API (via your **Settings → Cloud**
  token); a node with no detected public IP is flagged and won't be published.
- The pool serves TLS but does not issue it — a dormant `letsencrypt` resolver is
  defined only so catalog routers validate; issuance/renewal stays on the hub.
