# Autoscaling

nomploy has **three** related but distinct scaling surfaces. The word
"autoscaling" shows up in more than one place, so here's the map first:

| Surface | Where | What it scales |
|---|---|---|
| **Application autoscaling** | Application → **Advanced** → *Autoscaling* card | An app's replica count, automatically, between min/max. |
| **Live scaling** | App → **Advanced** → *Scaling* card, and Compose → **Containers** | The running job's replicas, right now (manual, or reflecting the policy). |
| **Cluster (node) autoscaling** | Nomad → **Autoscaling** tab | The number of **nodes** — provisions/destroys cloud VMs. |

The first two scale *your workload's replicas*; the third scales *the cluster's
machines*. All of them are driven by the Nomad Autoscaler.

## Application autoscaling

Turns an app's fixed replica count into a policy the Nomad Autoscaler manages.

**Application service → Advanced tab → Autoscaling card.** Flip the switch on and
set:

- **Min replicas** (default 1)
- **Max replicas** (default 3)
- **CPU target %** (optional) — e.g. `70`
- **Memory target %** (optional) — e.g. `80`

Set at least one of CPU / memory target (you'll get a validation error
otherwise), and keep max ≥ min. Click **Save**, then **redeploy** the app to
apply — the policy is baked into the job's `scaling` block on the next deploy.
With autoscaling **off**, the fixed replica count is used.

Behind the scenes this emits a Nomad `scaling { min, max, enabled = true, policy
{ … } }` block with `cpu`/`memory` checks against the `nomad-apm` source, using a
`target-value` strategy.

## Live scaling

The **Scaling** card (app → Advanced; compose → Containers, Nomad only) shows
each task group with its current `{running}/{desired}` count and, if it has an
autoscaling policy, its `min–max` range and an **autoscaling** / **manual**
badge. Type a number and click **Scale** to set the count immediately
(`nomad job scale`). Useful for a quick manual bump or to observe what the
autoscaler is doing.

## Compose service autoscaling (`x-nomad-scaling`)

For compose services, add an `x-nomad-scaling` policy to a service to get the
same `scaling` block in the generated job — min/max plus CPU/memory targets —
without the app-level form.

## Cluster (node) autoscaling

The Nomad page's **Autoscaling** tab configures the *node* autoscaler: the cloud
provider **token** and the **SSH key** used to provision and join new machines.
This is also the prerequisite for the Cluster tab's one-click **Add node** — see
[Cluster management](cluster.md). It scales the fleet of servers/workers, not
your app replicas.
