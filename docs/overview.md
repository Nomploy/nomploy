# Overview

The **Overview** page (sidebar → **Overview**) is a single, organization-wide
dashboard. Instead of opening each project to see what's running, it aggregates
the whole org into one view.

## What it shows

- **Services** — every application and compose service across all projects, with
  its status, so you can spot anything unhealthy at a glance.
- **Domains** — all configured domains in one list, with their target service and
  certificate state.
- **Backups** — scheduled database/volume backups across every project and when
  each last ran.
- **Deployments** — recent deployment activity org-wide.

Each row links straight through to the underlying service, domain, backup or
deployment, so Overview works as a jumping-off point as well as a status board —
useful once you run more than a couple of projects on the cluster.
