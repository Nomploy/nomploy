# Monitoring & Alerts

The **Alerts** page (sidebar → **Alerts**) watches cluster metrics and notifies
your cluster-alert channels when a metric crosses a threshold. It complements the
**Monitoring** tab (live utilization graphs) by turning those signals into
proactive notifications.

## Alert rules

Each rule watches one **metric** and fires when the value stays **over** (or
**under**) a **threshold** for a **window** (`forMinutes`), then **resolves** when
it recovers. On each transition (fire / resolve) it notifies every channel that
has **cluster alerts** enabled. Rules have a **severity** (critical / warning /
info) and can be **silenced** during maintenance (the rule still evaluates and
shows as firing — only the notification is suppressed).

Create a rule from **Alerts → New rule**: pick the metric, comparator, threshold,
window and severity. A live preview graph shows recent history for the metric.

## Available metrics

| Metric | Scope | Fires when |
|---|---|---|
| `lb_5xx_per_sec` | load balancer | 5xx rate over threshold |
| `lb_req_per_sec` | load balancer | request rate over threshold |
| `lb_latency_ms` | load balancer | average latency over threshold |
| `service_cpu_pct` | a service (or **all**) | CPU used vs reserved over threshold |
| `service_mem_pct` | a service (or **all**) | memory used vs reserved over threshold |
| `crowdsec_active_bans` | cluster | active CrowdSec bans over threshold |
| `crowdsec_detector_up` | cluster | the CrowdSec detector is **not** running |
| `otel_collector_up` | cluster | the OTel collector is **not** running |
| `log_agent_up` | cluster | some node's log agent is down |

The load-balancer and service metrics are averaged over the rule's window (see
[Load Balancer](load-balancer.md) and the Monitoring tab). The **service** metrics
can target a single service or **all services** — an all-services rule fans out
and fires/resolves each service independently.

## Security & observability health

The four cluster-wide metrics (`crowdsec_*`, `otel_collector_up`, `log_agent_up`)
are the "is it up / is something wrong" signals for the platform's own features:

- Each reports **not applicable** (the rule is skipped) when its feature is turned
  off, so *off* never reads as *down*.
- They are **debounced** — a breach must hold for the rule's window before it
  fires, so a brief dip during a rolling update (a collector/detector restart)
  doesn't flap the alert.

See [Security](security.md) and [Telemetry](telemetry.md) for the features behind
these metrics.

## Silences

Create a **silence** to mute notifications during a planned maintenance window.
An empty-matcher silence is org-wide; setting a rule, target or severity narrows
it. Rules keep evaluating and show as firing — only the matching notifications are
suppressed.
