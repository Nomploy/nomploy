# Security (CrowdSec)

nomploy ships a built-in **[CrowdSec](https://www.crowdsec.net/)** integration
that detects malicious HTTP traffic (scanning, probing, backdoor/CVE attempts,
aggressive crawling) from your Traefik access logs and can **block the offending
IPs at the ingress** — across every load-balancer node.

Open it from the sidebar (**Security**). It runs fully **locally and privately**:
no per-request calls leave the cluster, and the CrowdSec Central API is disabled.

## How it works

Two halves — a **brain** (detection) and **bouncers** (enforcement):

- **Brain — CrowdSec engine (LAPI + agent).** A single Nomad job
  (`nomploy-crowdsec`) runs on the hub. Its agent tails the hub Traefik access
  log and runs it through the `crowdsecurity/traefik` parsers + scenarios. When an
  IP trips a scenario (e.g. too many 4xx, known backdoor paths), the engine stores
  a **decision** (a ban: this IP/range, for a duration) in the **Local API
  (LAPI)**. Detection alone blocks nothing — it just maintains the ban list.
- **Bouncers.** The CrowdSec **Traefik plugin** runs as a middleware on every
  ingress Traefik — the HA pool nodes **and** the hub's standalone Traefik (so all
  nodes in the LB DNS are covered). In **stream mode** each bouncer pulls the ban
  list from LAPI (`<hub>:8083`) every ~60s and caches it; on each request it
  checks the client IP against the cache — banned → blocked, otherwise passes.

Flow: `request → Traefik (access log) → agent parses → scenario → ban in LAPI →
bouncers pull it (~60s) → that IP is blocked on every node`.

Evaluation is entirely local: rules (collections) are downloaded once at startup,
then matching runs in-process. The community Central API is off, so **nothing is
shared** and no community blocklist is pulled — bans come only from your own
traffic.

## Detection vs enforcement

Two toggles on the Security page:

- **Enable** — run the detector. You see the decisions (would-be bans) it
  produces, but nothing is blocked. Safe to run on its own to observe.
- **Enforce** — turn on the bouncers so banned IPs are actually blocked at the
  load balancer.

## Anti-lockout

The bouncer is given a **trusted-IP allowlist that always bypasses it**:

- the **WireGuard overlay subnet** (`10.10.0.0/24`) is always included, so the
  cluster, panel and intra-node traffic can never be blocked;
- plus any **CIDRs/IPs you add** on the Security page.

Add your **admin IP** to the allowlist before enforcing — the hub bouncer also
covers the panel's own route, so an allowlisted admin IP guarantees you keep
access. Recovery from a bad enforcement change is to toggle **Enforce** off (the
panel runs on the hub Traefik, independent of the pool).

## Enable it

1. Sidebar → **Security**.
2. **Enable CrowdSec** → Save. The detector deploys on the hub and starts listing
   decisions (it auto-enables the hub's file access log it needs).
3. Add your **admin IP** to the allowlist.
4. Turn on **Enforce** → Save to start blocking. Use the decisions table to
   **unban** an IP/range if needed.

## Notes

- **Scaling.** The pool bouncer is a Nomad system job, so any new node you tag
  `nomploy_lb` runs it automatically; the WG subnet in the allowlist covers new
  nodes' IPs, and all bouncers pull from the one LAPI on the hub. Adding nodes
  needs nothing extra.
- **Plugin fetch.** The Traefik bouncer plugin is fetched from
  `plugins.traefik.io` at Traefik startup. If you need full offline resilience,
  vendor it into a custom Traefik image.
- **Logs source.** Detection currently parses the **hub** Traefik access log; the
  HA pool ships its access logs to SigNoz via OTLP (see
  [Load Balancer](load-balancer.md) → Logs).
