# Telemetry (Observability)

nomploy runs a built-in **OpenTelemetry Collector** that gathers metrics and logs
from across the cluster and forwards them, in the open **OTLP** format, to any
backend you point it at — [SigNoz](https://signoz.io/), Grafana/Tempo/Loki,
Datadog, Honeycomb, or your own collector.

Open it from the sidebar (**Observability**). Nothing is sent anywhere until you
enable it and set a destination.

## How it works

- **Collector** — a Nomad job runs the OpenTelemetry Collector on the cluster. It
  **auto-discovers** scrape targets from the **Consul catalog** (every service
  nomploy registers), so you don't maintain a scrape list by hand.
- **Export** — everything is forwarded over **OTLP** (gRPC/HTTP) to the endpoint
  you configure, with an optional **auth profile** (named header/token sets) so
  you can target managed backends that require an ingestion key.
- **Per-node log agent** — when log shipping is on, a Nomad `system` job runs one
  lightweight agent per node that tails each local allocation's stdout/stderr and
  ships it as OTLP logs (one agent per node, so it can read that node's own logs).

## Signals (toggles)

Turn on only what you want to ship:

- **Service metrics** — per-service CPU/memory/throughput, auto-discovered from
  Consul.
- **Nomad metrics** — the Nomad runtime's own telemetry (schedulers, clients,
  allocations).
- **Service logs** — application stdout/stderr from every node (via the per-node
  log agent).
- **Load-balancer logs** — the HA Traefik pool's access logs, shipped natively
  over OTLP straight from Traefik (see [Load Balancer](load-balancer.md)).

## Set it up

1. Sidebar → **Observability**.
2. Set the **OTLP endpoint** of your backend and, if needed, an **auth profile**
   (e.g. an ingestion key header).
3. Enable the **signals** you want (metrics, Nomad metrics, service logs, LB logs).
4. **Save** — the collector (and, for service logs, the per-node agent) deploys
   automatically and starts forwarding. It self-heals on a panel roll or node loss.

> **SigNoz dashboards:** if you use SigNoz, nomploy ships importable dashboards for
> the cluster, services and load balancer. Grab the JSON from
> [`observability/signoz/`](observability/signoz/) and import them in SigNoz.

## Alerts

Observability health is alertable from the **Alerts** page: `otel_collector_up`
fires if the collector stops running, and `log_agent_up` fires if any node's log
agent is down — so a telemetry gap pages you instead of going unnoticed. See
[Monitoring & Alerts](alerts.md).

## Notes

- The collector and agents are right-sized automatically; memory per task scales
  with the number of discovered targets.
- Because export is plain OTLP, you are never locked to one backend — point it at
  a different endpoint and redeploy.
