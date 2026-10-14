# nomploy + Pulumi (prototype)

Manage nomploy services **as code**. This is a Pulumi **dynamic provider** written
in TypeScript that talks to the panel's existing REST API — no separate API layer,
no Go toolchain. It's a prototype that demonstrates the `project → application →
domain` lifecycle; extend it from there.

> **Status:** prototype. It creates/reads/updates/deletes projects, applications
> (**Docker image or generic git source**, with **deploy**), domains, the five
> **databases** (postgres / mysql / mariadb / mongo / redis), and **compose**
> services (raw compose file or Nomad Pack). Codegen from the OpenAPI spec is the
> remaining increment (see *Extending*).

## How it works

nomploy exposes its whole tRPC router set over HTTP (via `@dokploy/trpc-openapi`)
at `<endpoint>/api/<router>.<procedure>` — GET for queries, POST for mutations,
auth with the `x-api-key` header. Each Pulumi resource here maps its CRUD to those
procedures:

| Pulumi resource | create | read | update | delete |
|---|---|---|---|---|
| `Project` | `project.create` | `project.one` | `project.update` | `project.remove` |
| `Application` | `application.create` | `application.one` | `application.update` | `application.delete` |
| `Domain` | `domain.create` | `domain.one` | `domain.update` | `domain.delete` |
| `Postgres` / `Mysql` / `Mariadb` / `Mongo` / `Redis` (`Database`) | `<engine>.create` | `<engine>.one` | `<engine>.update` | `<engine>.remove` |
| `Compose` | `compose.create` | `compose.one` | `compose.update` | `compose.delete` |

`Application` sets its source via `application.saveDockerProvider` (image) **or**
`application.saveGitProvider` + `application.saveBuildType` (git), and deploys with
`application.deploy`. Each `Database` likewise deploys with `<engine>.deploy`.

`project.create` auto-creates a production environment and returns its id, exposed
as `project.environmentId` — pass it to `Application`.

An `Application` can also run a prebuilt image and deploy itself:

```ts
new nomploy.Application("api", {
  ...conn,
  name: "api",
  environmentId: project.environmentId,
  dockerImage: "nginxdemos/hello:latest",   // application.saveDockerProvider
  // registryUrl / registryUsername / registryPassword for a private registry
  deploy: true,                              // application.deploy on create + on image change
});
```

A `Compose` service from a raw compose file (translated to a Nomad job), deployed:

```ts
new nomploy.Compose("stack", {
  ...conn,
  name: "stack",
  environmentId: project.environmentId,
  composeFile: fs.readFileSync("docker-compose.yml", "utf8"),
  deploy: true,
});
// …or a Nomad Pack: { nomadPack: "traefik", nomadPackRegistry: "github.com/Nomploy/nomad-packs" }
```

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/) and Node.js 18+.
- An API key: panel → **Settings → API / Swagger** (or `POST /api/user.createApiKey`
  from an authenticated session). The first key must be minted from the UI/session;
  after that the provider only needs the key.

## Use it

```bash
cd iac/nomploy-pulumi
npm install

pulumi stack init dev
pulumi config set endpoint https://your-nomploy-instance.com
pulumi config set apiKey <your-x-api-key> --secret
pulumi config set host app.example.com      # optional — omit to skip the Domain

pulumi preview     # see the plan
pulumi up          # create project → application → domain
pulumi destroy     # tear it all down
```

`apiKey` is stored encrypted in the Pulumi state (it's marked a secret output).

## Extending

- **Docker / git source + deploy:** done — `Application` accepts `dockerImage`
  (+ registry creds) **or** `gitUrl`/`gitBranch` (+ `buildType`, `gitSshKeyId` for
  private), plus `deploy: true`.
- **Databases:** done — `Postgres` / `Mysql` / `Mariadb` / `Mongo` / `Redis` (or the
  generic `Database` with an `engine`), each with `deploy`.
- **Compose:** done — `Compose` takes a raw `composeFile` (composeType "nomad") or a
  `nomadPack` + `nomadPackRegistry` (composeType "nomad-pack"), with `deploy`.
- **Codegen:** the full surface is in the generated `openapi.json`
  (`apps/dokploy/scripts/generate-openapi.ts`) — a future version can generate typed
  resources from it instead of hand-writing each.

## Notes / caveats

- This is a **tRPC-flavored REST** API: everything is GET/POST to
  `/<router>.<procedure>`, IDs go in the body/query (not the URL path). The client
  in `src/nomploy/client.ts` handles that.
- Validate the JSON codec against your instance — the tRPC layer uses superjson
  internally; the OpenAPI handler is expected to use plain JSON, which this client
  assumes.
- It's a **dynamic provider**, so connection details (`endpoint`, `apiKey`) travel
  as resource inputs rather than ambient config.
