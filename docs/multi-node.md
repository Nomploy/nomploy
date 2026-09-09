# Adding worker nodes (multi-node cluster)

> **This page has moved.** Cluster setup is now covered by:
>
> - **[Cluster management](cluster.md)** — add/remove servers and workers, drain
>   nodes, HA status, DNS health, and network requirements.
> - **[Architecture](architecture.md)** — the control-plane/worker model and the
>   WireGuard overlay.

In short: the machine created by `install.sh` is the **control plane**. You add
capacity and high availability from the **Nomad → Cluster** tab — join a server
you've already registered with **Add existing server**, or provision a fresh
cloud VM with **Add node**. See [Cluster management](cluster.md) for the full
walkthrough.
