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
		// chpasswd expire:false is essential — the Hetzner Ubuntu image otherwise
		// forces a root password change on first login, which blocks every SSH
		// command (even with key auth) and hangs the worker join.
		const userData = `#cloud-config\nssh_authorized_keys:\n  - ${opts.sshPublicKey}\nchpasswd:\n  expire: false\n`;
		const baseBody: Record<string, unknown> = {
			name: opts.name,
			image: this.cfg.image,
			location: this.cfg.location,
			start_after_create: true,
			user_data: userData,
			labels: { "nomploy-autoscaled": "true", ...(opts.labels || {}) },
			public_net: { enable_ipv4: true, enable_ipv6: false },
		};
		if (this.cfg.networkId) baseBody.networks = [Number(this.cfg.networkId)];

		// Try each configured server type in order; skip a type that's deprecated
		// or not available in this location and fall back to the next.
		const types = this.cfg.serverTypes.filter(Boolean);
		if (types.length === 0) throw new Error("No server types configured");
		let id: number | undefined;
		let lastErr = "";
		for (const t of types) {
			try {
				const created = (await this.api("/servers", {
					method: "POST",
					body: JSON.stringify({ ...baseBody, server_type: t }),
				})) as { server: { id: number } };
				id = created.server.id;
				break;
			} catch (e) {
				lastErr = e instanceof Error ? e.message : String(e);
				// Only fall through on availability/deprecation errors.
				if (
					!/deprecated|unsupported location|resource_unavailable|not available/i.test(
						lastErr,
					)
				) {
					throw e;
				}
			}
		}
		if (id === undefined)
			throw new Error(
				`No configured server type could be created in ${this.cfg.location}: ${lastErr}`,
			);

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

	async listOptions() {
		const [locs, nets, types] = await Promise.all([
			this.api("/locations") as Promise<{
				locations: { name: string; description: string }[];
			}>,
			this.api("/networks?per_page=100") as Promise<{
				networks: {
					id: number;
					name: string;
					subnets: { network_zone: string }[];
				}[];
			}>,
			this.api("/server_types?per_page=100") as Promise<{
				server_types: {
					name: string;
					cores: number;
					memory: number;
					architecture: string;
					deprecated: boolean;
					cpu_type: string;
				}[];
			}>,
		]);
		return {
			locations: locs.locations.map((l) => ({
				name: l.name,
				description: l.description,
			})),
			networks: nets.networks.map((n) => ({
				id: String(n.id),
				name: n.name,
				zone: n.subnets?.[0]?.network_zone ?? "",
			})),
			serverTypes: types.server_types
				.filter((t) => !t.deprecated)
				.map((t) => ({
					name: t.name,
					cores: t.cores,
					memory: t.memory,
					architecture: t.architecture,
				})),
		};
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
