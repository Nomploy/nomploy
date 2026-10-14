# Infrastructure as Code

Everything nomploy exposes in the panel is also available over its **REST API**
(the tRPC router set, served at `<endpoint>/api/<router>.<procedure>` with an
`x-api-key` header). On top of that there's a **Pulumi provider** so you can manage
your services **as code** instead of clicking through the UI.

- **Repo:** [github.com/Nomploy/pulumi-nomploy](https://github.com/Nomploy/pulumi-nomploy)

A Pulumi **dynamic provider** over the REST API — no separate API layer and no Go
toolchain. Available in **TypeScript** (repo root) and **Python** (`python/`).
(Prototype: resources are complete and type-checked; APIs may still change.)

## Resources

| Resource | What it manages |
|---|---|
| `Project` | A project (auto-creates its production environment; exposes `environmentId`). |
| `Application` | An app, with a **Docker image** or **generic git** source and optional `deploy`. |
| `Postgres` / `Mysql` / `Mariadb` / `Mongo` / `Redis` | A managed database, with optional `deploy`. |
| `Compose` | A compose service — raw compose file or a Nomad Pack. |
| `Domain` | A domain routed to an application or compose service. |

## Quick start

```bash
git clone https://github.com/Nomploy/pulumi-nomploy
cd pulumi-nomploy
npm install

pulumi login --local
pulumi stack init dev
pulumi config set endpoint https://your-nomploy-instance.com
pulumi config set apiKey     <your-x-api-key>  --secret
pulumi config set dbPassword <postgres-pass>   --secret

pulumi up        # project → database + application(+deploy) → domain
pulumi destroy   # tear it down
```

Mint an API key in the panel under **Settings → API / Swagger**.

See the repo's README for the full resource reference, the generated typed API
client, and notes (database node placement, synchronous deploys, and more).

> **Languages:** Pulumi dynamic providers are language-specific, so TypeScript and
> Python each have their own implementation of the same resources (see the repo's
> `python/`). For other languages (Go, C#, …) a schema-based multi-language provider
> would be needed.
