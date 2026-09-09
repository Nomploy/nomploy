# Deploying

Everything nomploy runs ends up as a **Nomad job**. There are a few ways to get
there depending on what you're deploying.

## Applications and databases

For an **Application** or **Database** service you fill in settings (source,
image/build, env, ports, health, resources, replicas) and nomploy renders the
Nomad jobspec for you. This is the path most users use — see
[Getting Started](getting-started.md) for a walkthrough, and
[Autoscaling](autoscaling.md) and [GPU workloads](gpu.md) for the advanced knobs.

## Compose services

A **Compose** service gives you three deploy styles. You pick the style when you
create the service, via the **Compose Type** selector:

| Selector option | What it does |
|---|---|
| **docker-compose** | (Legacy Swarm-style compose.) |
| **Nomad (compose or HCL jobspec)** | The default. Accepts either a Docker Compose file *or* a native Nomad HCL job — auto-detected. |
| **Nomad Pack** | Deploys a [Nomad Pack](https://developer.hashicorp.com/nomad/tools/nomad-pack). |

The Deploy Settings card shows a read-only badge (**Compose** / **Nomad** /
**Nomad Pack**) reflecting the type.

### Compose → Nomad HCL (automatic)

Under **Nomad (compose or HCL jobspec)**, if your file is a Docker Compose file,
nomploy translates it to an equivalent Nomad job at deploy time:

- Each service becomes a task; ports, env, health checks, resources and replicas
  are carried over.
- Multi-replica services get a soft `spread` across nodes.
- Every allocation gets a `network.dns` block pointing at the cluster DNS
  servers, and Consul service registrations (with Traefik tags for any domains
  you've added) so ingress works automatically.
- `docker compose build` + `docker compose push` run before `nomad job run`.

You don't do anything special — just paste your compose file and deploy.

### Native Nomad HCL (automatic)

Sometimes you want full control. Under the **same** *Nomad (compose or HCL
jobspec)* type, if your file is a real Nomad job file — it contains a
`job "<name>" { … }` block — nomploy detects that and deploys it **verbatim**:
no translation, no compose build/push, no variable substitution. This is the
"deploy using Nomad syntax" path.

Use it when you need Nomad features that compose can't express (task groups,
templates, `volume`/`csi`, `constraint`, sidecars, and so on).

### Nomad Pack

Choose **Nomad Pack** to deploy a pack from the
[community registry](https://github.com/hashicorp/nomad-pack-community-registry)
or your own. The Deploy Settings card (**Nomad Pack**) has:

- **Pack** — the pack name, e.g. `traefik` or `hello_world`.
- **Custom registry (optional)** — a git URL. Leave blank to use the community
  registry; when set, it's added as a registry before the run.
- **Variables (HCL)** — pack variables (`count = 2`, `region = "global"`, …),
  passed as `--var-file`. Leave empty to use the pack's defaults.

Click **Save**, then **Deploy** to run the pack (`nomad-pack run`). Stop/delete
tear the pack down (`nomad-pack destroy`).

> **Pack and registry values are validated** to a safe character set, since they
> become part of the `nomad-pack` command line.

## What happens on deploy

Regardless of path, deployment is health-gated: the generated jobs use an
`update` block with `auto_revert`, so a failed rollout rolls back to the last
healthy version. Watch the deployment logs stream live in the UI.
