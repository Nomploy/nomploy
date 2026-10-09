# SigNoz dashboards

Pre-built SigNoz dashboards for a Nomploy cluster whose built-in **OTel Collector**
ships metrics and logs to SigNoz (Settings → Observability). See
[`../../registry.md`](../../registry.md) and the Observability page in the panel
for how the collector, per-node log agent and Traefik OTLP logs are wired up.

| File | Dashboard | What it shows |
|------|-----------|---------------|
| [`nomad-platform.json`](nomad-platform.json) | **Nomploy — Nomad / Platform** | Cluster health from Nomad's own `/v1/metrics`: running / blocked / pending allocations, per-node alloc & host CPU / memory / disk, Go runtime. |
| [`load-balancer.json`](load-balancer.json) | **Nomploy — Load Balancer** | ALB-style HA-pool Traefik view: requests/sec by entrypoint & status code, 2xx/3xx/4xx/5xx classes, latency p50/p90/p99, 4xx/5xx & requests per service, open connections, response throughput, and the native-OTLP access-log stream. |
| [`service-logs.json`](service-logs.json) | **Nomploy — Service Logs** | All service stdout/stderr shipped by the per-node OTel log agent: log volume by service & by node, error/warn rate, live log list. |

## Import

SigNoz → **Dashboards → New dashboard → Import JSON**, paste a file's contents.

Or via the API (token from `localStorage.AUTH_TOKEN` in a logged-in tab):

```bash
curl -sS -X POST https://<signoz-host>/api/v1/dashboards \
  -H "Authorization: Bearer $SIGNOZ_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @nomad-platform.json
```

## Notes

- Built for the SigNoz **v0.129** dashboard/widget schema (native query builder:
  `aggregations[]`, `filter.expression`, `groupBy` items with `id` + `isJSON`).
- SigNoz renames some Prometheus metrics: the Traefik latency histogram is
  `traefik_entrypoint_request_duration_seconds.bucket` (dotted) and open
  connections is `traefik_open_connections` — not the raw Prometheus names.
- Panels use a flat translucent area fill (`opacity` + `fillSpans`); SigNoz has
  no true gradient fill.
- The LB dashboard needs the collector's Traefik scrape job (pool-node `:8082`)
  and `shipLoadBalancerLogs` for the access-log panel; Service Logs needs
  `shipServiceLogs` (per-node log agent).
