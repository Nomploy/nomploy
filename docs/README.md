# nomploy docs

Guides for running **nomploy** — a self-hostable PaaS that deploys your apps and
databases onto a **[HashiCorp Nomad](https://www.nomadproject.io/)** cluster.

New here? Start with **[Getting Started](getting-started.md)**, then come back for
the topic you need.

## Guides

| Guide | What it covers |
|---|---|
| **[Getting Started](getting-started.md)** | Install on a fresh VPS, first login, deploy your first app. |
| **[Architecture](architecture.md)** | How nomploy maps to Nomad, Consul, Traefik and the WireGuard overlay. |
| **[Cluster management](cluster.md)** | Grow to a highly-available multi-node cluster: add/remove servers and workers, drain nodes, DNS health. |
| **[Deploying](deploying.md)** | Compose → Nomad HCL, native Nomad job files, and Nomad Pack. |
| **[Autoscaling](autoscaling.md)** | Horizontal autoscaling for applications and compose services. |
| **[Load Balancer](load-balancer.md)** | HA Traefik pool, DNS health-prune, shared certs, metrics & logs tabs. |
| **[Telemetry](telemetry.md)** | Built-in OpenTelemetry Collector → any OTLP backend (SigNoz, Grafana, Datadog); service auto-discovery and signal toggles. |
| **[Monitoring & Alerts](alerts.md)** | Metric alert rules (LB, service, and security/observability health) → cluster-alert notifications, with silences. |
| **[Security](security.md)** | Built-in CrowdSec: detect malicious traffic and block offending IPs at the ingress (detection vs enforce, anti-lockout). |
| **[Container registry](registry.md)** | One-click self-hosted zot+S3/R2, or run your own + Add Registry; credentials distributed cluster-wide. |
| **[Overview](overview.md)** | Org-wide dashboard aggregating services, domains, backups and deployments across every project. |
| **[Infrastructure as Code](iac.md)** | Manage services as code with the Pulumi provider, over the REST API. |
| **[GPU workloads](gpu.md)** | Requesting NVIDIA GPUs for a job. |

## Quick reference

- **Install:** `curl -sSL https://nomploy.com/install.sh | sh`
- **Image:** `ghcr.io/nomploy/nomploy` (override with `NOMPLOY_IMAGE=…`)
- **License:** AGPL-3.0 (portions Apache-2.0). See [`../LICENSING.md`](../LICENSING.md).

If something here doesn't match what you see in the UI, the code is the source of
truth — please open an issue.
