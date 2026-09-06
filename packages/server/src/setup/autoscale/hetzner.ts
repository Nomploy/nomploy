import type {
	AutoscaleProviderConfig,
	NodeProvisioner,
	ProvisionedNode,
	ProvisionOptions,
} from "./provisioner";

/**
 * Hetzner Cloud node provisioner (hcloud API v1).
 *
 * Creates an Ubuntu VM attached to the cluster's private network, authorizing
 * the panel's SSH key via cloud-init so the generic Nomad worker join can SSH in
 * and install + join it. Marked with a nomploy-autoscaled label so the reconcile
 * loop only ever destroys its own nodes.
 */
const API = "https://api.hetzner.cloud/v1";

export class HetznerProvisioner implements NodeProvisioner {
	readonly provider = "hetzner";
	private token: string;
	private cfg: AutoscaleProviderConfig;

	constructor(cfg: AutoscaleProviderConfig) {
		this.token = cfg.token;
		this.cfg = cfg;
	}

	private async api(path: string, init?: RequestInit) {
		const res = await fetch(`${API}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
				...(init?.headers || {}),
			},
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			// Never echo the token; hcloud errors don't include it.
			throw new Error(`Hetzner API ${res.status} ${res.statusText}: ${body}`);
		}
		return res.status === 204 ? {} : res.json();
	}

	async createNode(opts: ProvisionOptions): Promise<ProvisionedNode> {
		const userData = `#cloud-config\nssh_authorized_keys:\n  - ${opts.sshPublicKey}\n`;
		const body: Record<string, unknown> = {
			name: opts.name,
			server_type: this.cfg.serverType,
			image: this.cfg.image,
			location: this.cfg.location,
			start_after_create: true,
			user_data: userData,
			labels: { "nomploy-autoscaled": "true", ...(opts.labels || {}) },
			public_net: { enable_ipv4: true, enable_ipv6: false },
		};
		if (this.cfg.networkId) body.networks = [Number(this.cfg.networkId)];

		const created = (await this.api("/servers", {
			method: "POST",
			body: JSON.stringify(body),
		})) as { server: { id: number } };
		const id = created.server.id;

		// Poll until running + (if a network was requested) a private IP is assigned.
		const wantPrivate = !!this.cfg.networkId;
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 3000));
			const s = (await this.api(`/servers/${id}`)) as {
				server: {
					status: string;
					public_net: { ipv4: { ip: string } | null };
					private_net: { ip: string }[];
				};
			};
			const running = s.server.status === "running";
			const privateIp = s.server.private_net?.[0]?.ip;
			const publicIp = s.server.public_net?.ipv4?.ip ?? "";
			if (running && (!wantPrivate || privateIp)) {
				return { providerId: String(id), name: opts.name, publicIp, privateIp };
			}
		}
		// Timed out — clean up the half-created VM so we don't leak it.
		await this.destroyNode(String(id)).catch(() => {});
		throw new Error(`Hetzner server ${id} did not become ready in time`);
	}

	async destroyNode(providerId: string): Promise<void> {
		try {
			await this.api(`/servers/${providerId}`, { method: "DELETE" });
		} catch (e) {
			// A 404 (already gone) is success; rethrow anything else.
			if (!(e instanceof Error) || !/\b404\b/.test(e.message)) throw e;
		}
	}
}
