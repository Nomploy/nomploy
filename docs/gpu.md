# GPU workloads

nomploy schedules NVIDIA GPUs through Nomad's `nomad-device-nvidia` plugin. There
are two steps: enable GPU support on the node, then request a GPU in your job.

## 1. Enable GPU support on the node

The **NVIDIA driver (`nvidia-smi`) must already be installed** on the machine —
nomploy does not install the kernel driver.

Open the server's setup/actions and use **GPU Configuration → Enable GPU
Support**. This:

- installs the NVIDIA Container Toolkit,
- points Docker at the `nvidia` runtime, and
- installs the `nomad-device-nvidia` plugin so Nomad can fingerprint and schedule
  the GPUs.

The card shows the detected GPU status and becomes **Reconfigure GPU** once set
up.

## 2. Request a GPU in your workload

There's no separate GPU form field — you request GPUs in your service definition.

### Docker Compose

Use the standard compose device reservation:

```yaml
services:
  trainer:
    image: my/cuda-app:latest
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

A device is treated as a GPU when its `driver` is `nvidia` **or** its
`capabilities` include `gpu`. The `count` is summed across matching devices;
`count: all` or an omitted count is treated as **1**. nomploy turns that into a
Nomad `device "nvidia/gpu" { count = N }` block in the generated job. (`nvidia/gpu`
matches any NVIDIA GPU the plugin fingerprints.)

### Native Nomad HCL

If you deploy a [native HCL job](deploying.md#native-nomad-hcl-automatic), request
the device directly in the task's `resources`:

```hcl
resources {
  cpu    = 2000
  memory = 4096
  device "nvidia/gpu" {
    count = 1
  }
}
```

This gives you the full device-plugin surface (constraints on model, memory,
`affinity`, etc.) if you need it.

## Notes

- GPUs are only schedulable on nodes where you enabled GPU support in step 1.
- Combine with a `constraint` if you have a mixed fleet and want a job pinned to
  GPU nodes.
