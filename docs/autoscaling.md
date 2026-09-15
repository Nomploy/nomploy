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

### Config knobs

Per autoscaling group (Nomad node pool):

| Knob | Meaning |
|---|---|
| **enabled** | Master switch for the group's reconcile loop. |
| **min / max** | Hard floor / ceiling on the **total** worker count in the pool (manual + autoscaled). |
| **desired** | The current target the loop drives toward, clamped to `[min, max]`. Manual sets, scheduled actions, and reactive pressure all move this. |
| **scale-up CPU % / mem %** | Reserved CPU / memory at or above which the loop nudges the target up (defaults 80 / 75). |
| **scale-down CPU % / mem %** | Reserved CPU / memory at or below which — both, with no blocked evals — it nudges the target down (default 25 / 25). |
| **cooldown** | Minimum seconds between scale actions, so one node moves per cooldown instead of thrashing (default 300). |
| **server type / location** | The cloud VM spec + region provisioned for new autoscaled nodes. |

### How it decides (desired-count model)

Each tick (~60s) the loop, per group:

1. Measures **reserved** CPU/memory — what Nomad has *scheduled* onto the pool's
   ready+eligible nodes (not live usage) — and counts **blocked evaluations**
   targeting the pool (allocations that couldn't be placed).
2. **Converges to `desired` first.** If `workerCount < desired` it scales **up**;
   if `workerCount > desired` it scales **down** — but only ever removes an
   **autoscaled** node. If the surplus is all manual/pinned it reports
   `none (above desired … but the extras are pinned/manual)`.
3. **Only when `workerCount == desired`** does it evaluate pressure: reserved
   CPU/mem over the scale-up threshold (or any blocked eval) nudges `desired +1`;
   slack under *both* scale-down thresholds nudges `desired −1` (never below
   `min`). Because the nudge only happens *at* target, `desired` never runs more
   than one node ahead of reality, and the cooldown paces one change per interval.

Scale-up provisions a cloud VM (hostname-safe name), joins it to the pool, and it
becomes a ready worker. Scale-down drains an autoscaled worker, removes it, and
**destroys its VM** — so idle capacity stops billing.

### Manual (pinned) nodes and the `min` floor

A node added manually / one-click (`autoscaled = false`) is **pinned**: it counts
toward `workerCount` but is **never reclaimed** by scale-down. That interacts with
`min` in a way that's easy to get wrong:

> **Gotcha:** `min` (and therefore `desired`) must be **at least the number of
> pinned workers**. If a pool has one pinned worker but `min = 0 / desired = 0`,
> the loop is permanently in the "`workerCount(1) > desired(0)` but pinned" branch
> and **never reaches the pressure check** — so it will *never* scale up under
> load. Set `min = 1 / desired = 1` (with the pinned worker as the floor) and the
> loop sits "at desired," free to nudge up under load and back down when idle,
> with **zero extra idle cost** beyond the node you already run.

### Example: elastic with a pinned baseline

One pinned manual worker, burst up to two more under load:

```
min = 1, desired = 1, max = 3
scale-up   CPU ≥ 80%  or mem ≥ 75%  (or any blocked eval)
scale-down CPU ≤ 25% and mem ≤ 25%
cooldown   300s
```

- **Idle:** stays at the 1 pinned worker; no autoscaled VMs, no extra cost.
- **Load:** reserved CPU crosses 80% → provisions an autoscaled VM (one per
  cooldown) up to `max = 3`.
- **Load clears:** reserved CPU/mem fall under 25% → removes autoscaled VMs and
  destroys them, back down to the pinned floor of 1.
