# nomploy + Pulumi (prototype)

Manage nomploy services **as code**. This is a Pulumi **dynamic provider** written
in TypeScript that talks to the panel's existing REST API — no separate API layer,
no Go toolchain. It's a prototype that demonstrates the `project → application →
domain` lifecycle; extend it from there.

> **Status:** prototype. It creates/reads/updates/deletes the three core resources
> over the REST API. Source/build config and deploy triggers are intentionally
> left out of the first cut (see *Extending* below).

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

`project.create` auto-creates a production environment and returns its id, exposed
as `project.environmentId` — pass it to `Application`.

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

- **Source + deploy:** after `application.create`, call `application.saveDockerProvider`
  / `application.saveGithubProvider` + `application.saveBuildType`, then
  `application.deploy`. Add these to the `Application` provider (e.g. a `deploy: true`
  flag, or a dedicated `Deployment` resource).
- **Databases:** `postgres` / `mysql` / `mariadb` / `mongo` / `redis` share the same
  `create / one / update / remove` shape — add resources the same way as `Application`.
- **Compose:** `compose.create` mirrors `application.create` (needs `environmentId`).
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
