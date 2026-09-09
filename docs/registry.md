# Built-in registry

nomploy can run its own OCI image registry on the control plane, so you can
build → push → pull without signing up for an external registry. It's powered by
**[zot](https://zotregistry.dev/)** (a single-binary, OCI-native, Apache-2.0
registry) and stores images on the local disk or an S3-compatible bucket.

## Where it lives

**Dashboard → Settings → Registry.** The card is titled **"Built-in registry
(zot)"** with an **enabled** / **disabled** badge.

## Configure

Fill in the settings, then enable:

- **Storage** — *Local filesystem* or *S3-compatible* (default: local).
- **Port** — the port the registry listens on (default **5000**).
- **Username** — default `nomploy`.
- **Password** — set one (required to enable). Leaving it blank on a later save
  keeps the stored password.

When **S3-compatible** is selected, an extra panel appears:

- **Bucket**
- **Region**
- **Endpoint (S3-compatible; blank for AWS)** — e.g. `minio.example.com` or
  `s3.eu-central-1.amazonaws.com`.
- **Access key ID**
- **Secret access key**

Click **Save settings** to persist the config.

> The registry is served over **HTTP** on the overlay network (not public TLS),
> which is why nomploy adds it to each node's Docker `insecure-registries`.

## Enable

Click **Enable** (it becomes **Reconfigure** once running). nomploy will:

1. Deploy the zot registry as a Nomad job on the control plane.
2. Add the registry address to **every node's** Docker `insecure-registries`
   (a non-disruptive reload — running containers aren't restarted).
3. Wait for the registry's `/v2/` endpoint to answer.
4. `docker login` from the control plane so builds can push.
5. Register it as a nomploy registry named *Built-in registry (zot)* with the
   image prefix `nomploy`, so your services can use it.

Once enabled, the card shows the address (e.g. `10.10.0.1:5000`) with a copy
button and a push hint:

```bash
docker push <address>/nomploy/<image>
```

## Disable

**Disable** stops and purges the registry job but **keeps your stored blobs and
config**, so you can re-enable later without losing images.

## S3 vs. local — which?

- **Local filesystem** is the simplest — good for a single control plane.
- **S3-compatible** keeps images off the node's disk and survives a control-plane
  rebuild. Works with AWS S3 (leave the endpoint blank) or any S3-compatible
  service like MinIO or Cloudflare R2 (set the endpoint). Credentials are written
  into the registry's storage config.
