# Research: adding AWS EC2 as a second cloud provider

**Status:** research / design only — no code written.
**Date:** 2026-10-16 · **Target:** nomploy (dokploy fork), autoscaling + one-click "Add node".

---

## TL;DR

- The node-provisioning layer is **already abstracted** behind a `NodeProvisioner`
  interface. Hetzner is the *only* implementation; the reconcile loop, the
  SSH+WireGuard+Nomad join, and the DB schema (which already has a `provider`
  discriminator column) are cloud-agnostic.
- Adding AWS EC2 is therefore **mostly one new class** (`createNode` /
  `destroyNode` / `listOptions`) + registering it + relaxing a few Hetzner
  hardcodes (a token-test branch, the UI provider dropdown, a few default
  literals).
- **The one genuinely new design problem is networking**, not the EC2 API:
  nomploy's cluster is a WireGuard mesh and today it prefers each node's
  *provider-private* IP for the WG endpoint (fine inside one Hetzner private
  network, broken across clouds). AWS nodes must join over **public** WG
  endpoints, which has security (security-group) and **cost** (AWS egress)
  implications.
- **Economics:** AWS on-demand compute is ~3–10× Hetzner and AWS **meters
  egress (~$0.09/GB)** where Hetzner bundles transfer. So AWS is not a
  "cheaper nodes" play — it's a **reach / burst / spot** play (see use cases).

---

## 1. How it would actually be used (the "why")

Given the cost reality, AWS nodes make sense for:

1. **Geographic reach** — run workers in an AWS region close to users where
   Hetzner has no presence (e.g. `us-east-1`, `ap-southeast-1`, `sa-east-1`).
   A node pool tagged to that region + Nomad constraints pins latency-sensitive
   services there.
2. **Burst / overflow capacity** — the autoscaler already scales a node pool on
   reservation pressure. An AWS pool can absorb short spikes without buying
   permanent Hetzner capacity; **Spot instances** make burst cheap (often
   60–90% off on-demand) at the cost of possible interruption — a good fit for
   stateless autoscaled *workers* (never for stateful/DB nodes).
3. **AWS-native data gravity** — workloads that talk heavily to S3/RDS/SQS in a
   region are cheaper and faster co-located there (and egress to AWS services in
   the same region is free), offsetting the compute premium.
4. **Resilience / multi-cloud** — survive a Hetzner-wide incident by keeping a
   warm pool (min>0) on a second provider.

**Anti-use-cases:** replacing Hetzner for always-on baseline compute (too
expensive), or chatty cross-cloud service meshes (every byte between an AWS node
and a Hetzner node is AWS egress — see §3).

Net: ship AWS as an **additional node pool provider for autoscaled workers**,
not as a new home for the control plane or databases.

---

## 2. Current architecture (what's already done)

| Concern | File | State |
|---|---|---|
| Provisioner interface | `packages/server/src/setup/autoscale/provisioner.ts` | ✅ cloud-agnostic |
| Factory / registry | `packages/server/src/setup/autoscale/index.ts` (`getProvisioner`, `SUPPORTED_PROVIDERS`) | extend here |
| Hetzner impl | `packages/server/src/setup/autoscale/hetzner.ts` | reference impl |
| Reconcile / scale loop | `packages/server/src/setup/autoscale/reconcile.ts` | ✅ agnostic |
| SSH + WG + Nomad join | `autoscale/join.ts`, `setup/nomad-cluster.ts`, `setup/nomad-mesh.ts` | ✅ agnostic (pure SSH+WG) |
| Credential table | `db/schema/cloud-provider.ts` (`provider` column, default `"hetzner"`) | ✅ discriminator exists |
| Node-pool table | `db/schema/cluster-autoscaler.ts` (`provider`, `serverType`, `location`, `image`) | Hetzner default literals |
| Provisioned-node tracking | `db/schema/server.ts` (`autoscaled`, `providerNodeId`, `wgIp`, `nodePool`) | ✅ (no provider stored on row; re-derived from pool) |
| Cloud UI | `components/dashboard/settings/cloud/*`, nav `layouts/side.tsx` | provider dropdown hardcoded |
| Autoscaler UI | `components/dashboard/nomad/autoscale/show-autoscaler.tsx` | Hetzner placeholders |

The interface (verbatim):

```ts
export interface NodeProvisioner {
	readonly provider: string;
	createNode(opts: ProvisionOptions): Promise<ProvisionedNode>;   // {name, sshPublicKey, labels?}
	destroyNode(providerId: string): Promise<void>;
	listOptions(): Promise<ProviderOptions>;                        // {locations, networks, serverTypes}
}
// ProvisionedNode = { providerId, name, publicIp, privateIp? }
```

Everything downstream of `createNode` (insert `server` row → `waitForSsh` →
`joinWorkerNode`) is reused unchanged.

---

## 3. Networking — the real work (cross-cloud WireGuard)

This is the part that is **not** solved by "just call the EC2 API".

### 3.1 The private-IP assumption

`reconcile.ts` sets the node's `ipAddress` (used for **both** SSH bootstrap and
the WG endpoint) as:

```ts
const ip = node.privateIp || node.publicIp;   // reconcile.ts L456 and L655
```

For Hetzner this resolves to the `10.14.x` private-network IP, which works
because the hub and all Hetzner nodes share one private network. An AWS node's
`privateIp` is a VPC address (e.g. `10.0.x.x`) that is **unreachable from
Hetzner** — SSH bootstrap and WG would both fail.

→ **The AWS provisioner must return `privateIp: undefined`** so `ip = publicIp`.
SSH and the node's WG endpoint then use the public IP. (Clean, no reconcile
change needed — but worth a code comment, and ideally reconcile should prefer
`publicIp` whenever the node's provider differs from the hub's.)

### 3.2 WG endpoints must be public for cross-cloud members

- WG peer endpoints are built as `${server.ipAddress}:51820` (`join.ts` L129)
  and the hub advertises `hubEndpoint` (`nomad-cluster.ts` L296,
  `nomad-mesh.ts` L100), read from `cluster.json`.
- Workers are **client peers** (keepalive to server endpoints, no inbound
  endpoint of their own — `join.ts` L67), so an AWS **worker** only needs
  **outbound** UDP 51820 to the hub/server public endpoints + **inbound SSH**
  from the panel. Server-role nodes are full-mesh and need inbound WG.
- **Prerequisite:** the hub (and any server-role node an AWS worker peers with)
  must advertise a **public** `hubEndpoint`/endpoint reachable from AWS, with
  its firewall open on UDP 51820 to the AWS node's public IP. On a pure-Hetzner
  cluster `hubEndpoint` may currently be the private IP — adding an off-Hetzner
  node requires it to be public. **Verify/parameterize this before shipping.**

### 3.3 Security group (minimum)

For an AWS **worker** node:
- Inbound: TCP 22 (SSH) from the hub's public IP only.
- Inbound: UDP 51820 (WG) from peer public IPs (hub + server-role nodes) — only
  strictly needed if the node is ever a full-mesh/server member; pure workers
  can rely on keepalive, but allowing it from known peers is safer.
- Outbound: allow all (default) — needed for WG, image pulls, Nomad/Consul.
- **Do not** expose Nomad/Consul (4646/8500/…) publicly — they ride the WG
  overlay only.

### 3.4 Cost: egress

All traffic between an AWS node and the rest of the (Hetzner) mesh — WG overlay
service-to-service calls, Nomad/Consul gossip, log/metric shipping — leaves AWS
as metered egress (~$0.09/GB after the free tier). Keep AWS workloads either
self-contained or AWS-region-local. Document this prominently in the UI when a
user adds an AWS pool.

---

## 4. AWS EC2 provider design

New file: `packages/server/src/setup/autoscale/aws.ts` —
`class AwsProvisioner implements NodeProvisioner` (`readonly provider = "aws"`).

### 4.1 Credentials

- Store an **access key id + secret access key** in the existing
  `cloud_provider.token` column, encoded as `"<AKID>:<SECRET>"` (or add a small
  JSON blob). Region comes from the node pool's `location` field.
- Minimum IAM policy for that key:
  `ec2:RunInstances`, `ec2:TerminateInstances`, `ec2:DescribeInstances`,
  `ec2:DescribeInstanceTypes`, `ec2:DescribeRegions`,
  `ec2:DescribeAvailabilityZones`, `ec2:CreateTags`, `ssm:GetParameters`
  (for AMI resolution), and `ec2:ImportKeyPair`/`DescribeKeyPairs` only if we
  pre-register the SSH key (we don't need to — see 4.4).
- Document that the key should be **scoped to one region / least privilege**.

### 4.2 SDK

- Add dependency **`@aws-sdk/client-ec2`** (modular v3; not currently a dep).
  AMI resolution can use the `resolve:ssm:` ImageId trick (below) to avoid also
  pulling `@aws-sdk/client-ssm`.
- Instantiate per-call with `{ region, credentials: { accessKeyId, secretAccessKey } }`.

### 4.3 AMI selection

Use SSM public parameters so we never hardcode/rotate AMI ids. Ubuntu 24.04:
```
/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id
```
(`arm64` variant for Graviton instance types.) Pass directly as
`ImageId: "resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"`
in `RunInstances` — AWS resolves it server-side, so no extra API call/role for
SSM read is needed at launch. The pool's `image` field can store this path (or a
friendly "ubuntu-24.04" that we map).

### 4.4 `createNode`

`RunInstancesCommand` with:
- `ImageId` (resolve:ssm as above), `InstanceType` (from pool `serverType`),
  `MinCount/MaxCount: 1`.
- `UserData` = base64 `#cloud-config` that authorizes `opts.sshPublicKey`
  (exact analogue of the Hetzner cloud-init at `hetzner.ts` L49 — reuse the
  same string; no `chpasswd` quirk needed on AWS Ubuntu). This avoids managing
  EC2 key pairs entirely.
- `TagSpecifications` → `Name = opts.name`, `nomploy-autoscaled = true`, plus
  `opts.labels`.
- `NetworkInterfaces[0]` with `AssociatePublicIpAddress: true`, the chosen
  `SubnetId`, and the `Groups: [securityGroupId]` (see §3.3 / open questions on
  how SG/subnet are chosen).
- `InstanceMarketOptions: { MarketType: "spot" }` when the pool opts into spot.
- Then **poll `DescribeInstances`** until `running` + a `PublicIpAddress` is
  present (mirror Hetzner's 60×3s poll at `hetzner.ts` L94).
- Return `{ providerId: instanceId, name, publicIp, privateIp: undefined }`
  (privateIp omitted deliberately — §3.1).

Iterate candidate instance types on `InsufficientInstanceCapacity` /
unsupported-type errors, like the Hetzner fallback loop.

### 4.5 `destroyNode`

`TerminateInstancesCommand({ InstanceIds: [providerId] })`; treat
already-terminated / not-found as success (match Hetzner's 404-is-ok). If we
allocate Elastic IPs (we shouldn't for autoscaled workers — a public IP from the
subnet is enough and avoids EIP leakage), release them here.

### 4.6 `listOptions`

- `locations` ← `DescribeRegions` (or a curated region list) + optionally
  `DescribeAvailabilityZones` per region.
- `serverTypes` ← a **curated** map of sensible instance types
  (e.g. `t3.small/medium/large`, `m7i.large`, `c7g.*` for arm64) with
  cores/memory/architecture, since `DescribeInstanceTypes` returns thousands.
  (The interface's `serverTypes[].architecture` already lets the UI/provisioner
  pick the matching AMI arch.)
- `networks` ← VPCs/subnets (or leave empty and resolve a default VPC subnet at
  launch — see open questions).

---

## 5. Change surface (concrete)

**New:**
1. `packages/server/src/setup/autoscale/aws.ts` — the `AwsProvisioner` class.
2. Dependency `@aws-sdk/client-ec2` in `packages/server/package.json`.

**Edit (small):**
3. `autoscale/index.ts` — add `case "aws": return new AwsProvisioner(cfg)` to
   `getProvisioner`, add `"aws"` to `SUPPORTED_PROVIDERS`.
4. `apps/dokploy/server/api/routers/cloud-provider.ts` L16-34 `testProviderToken`
   — add an `aws` branch (e.g. a cheap `DescribeRegions` to validate creds).
5. `components/dashboard/settings/cloud/handle-cloud-provider.tsx` L37-38
   `PROVIDERS` — add `{ key: "aws", name: "AWS EC2" }`; the add/edit dialog needs
   two secret fields (access key + secret) and a region, or keep the single
   `token` field with `AKID:SECRET` + region on the pool.
6. Provider-aware defaults instead of Hetzner literals: `cluster-autoscaler.ts`
   defaults (`cpx22`/`nbg1`/`ubuntu-24.04`), `nomad.ts` `listProviderOptions`
   L4053-4055, `show-autoscaler.tsx` L60-65 placeholders.

**Verify before shipping:**
7. `hubEndpoint` is a public, WG-reachable address when any off-Hetzner node
   exists (§3.2); hub firewall allows UDP 51820 from the AWS node.
8. Consider making `reconcile.ts` prefer `publicIp` when the node's provider ≠
   the hub's provider, rather than relying on the provisioner returning
   `privateIp: undefined`.

---

## 6. Phased plan

- **Phase 0 (spike, no UI):** `AwsProvisioner` + register it + add AWS creds via
  the existing form (token = `AKID:SECRET`, pool `location = region`,
  `serverType = t3.medium`, `image =` the SSM path). Manually create a pool row,
  run one-click "Add node", confirm the EC2 worker boots, SSHes, joins WG+Nomad,
  and shows in the node list. This validates the networking end-to-end on the
  real cluster before investing in UI.
- **Phase 1 (productize):** provider dropdown + AWS-specific add-credential form
  (2 secrets + region), `testConnection` branch, provider-aware option lists and
  defaults, egress/cost warning banner on AWS pools.
- **Phase 2 (spot + ergonomics):** Spot toggle on the pool (cheap burst
  workers), curated instance-type catalog with live pricing hints, optional
  arm64 (Graviton) support, region picker from `DescribeRegions`.
- **Phase 3 (hardening):** auto-create/&reuse a dedicated SG + tag-based cleanup
  of orphaned instances, EIP hygiene, IAM policy doc, interruption handling for
  spot (drain on the 2-min notice).

---

## 7. Risks & open questions

- **VPC/subnet/SG sourcing.** Simplest MVP: require the user to pass an existing
  `subnetId` + `securityGroupId` (per pool) that already allow the §3.3 rules.
  Nicer later: auto-discover the default VPC and create a managed SG. *Decision
  needed: MVP = user-supplied subnet+SG, or auto-manage?*
- **Credential shape.** Reuse the single `token` column (`AKID:SECRET`) to avoid
  a migration, or add `secretKey`/`region` columns to `cloud_provider`?
  *Recommend: reuse `token` for the spike; add fields in Phase 1 if the UX needs
  it.*
- **Egress cost surprise** — must be surfaced in the UI; a chatty service placed
  on an AWS node could run up a bill. Mitigate with Nomad constraints / docs.
- **Spot interruptions** — only for stateless workers; wire the 2-min
  interruption notice to a Nomad drain in Phase 3.
- **Hub endpoint publicization** — if a user's hub only has a private WG
  endpoint today, enabling AWS must flip it public; needs a guard + clear error.
- **`token` at rest is plaintext** (same as Hetzner today) — AWS keys are more
  sensitive; consider encryption-at-rest as a follow-up (applies to Hetzner too).

---

## 8. Cost reference (directional, 2026)

| Config | Hetzner (on-demand) | AWS EC2 (on-demand) | AWS Spot (typical) |
|---|---|---|---|
| 2 vCPU / 4 GB | CX23 ≈ €4.5/mo | t3.medium ≈ $30/mo | ~$9/mo |
| 8 vCPU / 16 GB | CPX41 ≈ $33/mo | ~$225/mo (c-class) | ~$70/mo |
| Egress | bundled (TBs) | ~$0.09/GB | ~$0.09/GB |

AWS ≈ **3–10× Hetzner on compute**, plus metered egress — reinforcing the
"reach/burst/spot, not baseline" positioning.

*Sources:* AWS SDK for JavaScript v3 EC2 client; Canonical Ubuntu-on-AWS SSM AMI
parameters; public Hetzner-vs-AWS pricing comparisons (umh.app, spendark,
solodevstack), 2026.
