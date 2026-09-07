/**
 * Phase C — cluster autoscaling: pluggable node provisioner.
 *
 * The autoscaler reconcile loop (reconcile.ts) is cloud-agnostic; it only knows
 * this interface. Each cloud (Hetzner first, then AWS/DO/…) implements it. A
 * provisioner creates/destroys a bare VM that is reachable over SSH with the
 * panel's key and (ideally) attached to the cluster's private network — the
 * generic Nomad worker join (Phase A) then installs + joins it.
 */

export interface ProvisionOptions {
	/** Unique name for the VM (also used as the nomploy server name). */
	name: string;
	/** Panel SSH public key to authorize for root, so joinCluster can SSH in. */
	sshPublicKey: string;
	/** Labels/tags to mark the VM as nomploy-autoscaled. */
	labels?: Record<string, string>;
}

export interface ProvisionedNode {
	/** Cloud-specific VM id (used for destroy). */
	providerId: string;
	name: string;
	/** Public IPv4 (fallback SSH target when no private network). */
	publicIp: string;
	/**
	 * Private IPv4 on the cluster's network, if the VM was attached to one.
	 * Preferred as the nomploy server ipAddress (the hub reaches it privately +
	 * derives the WireGuard endpoint from it — same as Phase A).
	 */
	privateIp?: string;
}

/** Options the UI offers (populated from the cloud API once a token is set). */
export interface ProviderOptions {
	locations: { name: string; description: string }[];
	networks: { id: string; name: string; zone: string }[];
	serverTypes: {
		name: string;
		cores: number;
		memory: number;
		architecture: string;
	}[];
}

export interface NodeProvisioner {
	/** Human-readable provider id, e.g. "hetzner". */
	readonly provider: string;
	/** Create a VM and wait until it is running + SSH-reachable. */
	createNode(opts: ProvisionOptions): Promise<ProvisionedNode>;
	/** Destroy a VM by its provider id (idempotent — missing = success). */
	destroyNode(providerId: string): Promise<void>;
	/** List locations / networks / server types for the UI to choose from. */
	listOptions(): Promise<ProviderOptions>;
}

/** Config common to every provisioner, persisted (token encrypted) in the DB. */
export interface AutoscaleProviderConfig {
	provider: string;
	/** Cloud API token/secret. */
	token: string;
	/** VM sizes to try in order (first that's available in the location wins). */
	serverTypes: string[];
	/** Region/location, e.g. Hetzner "nbg1". */
	location: string;
	/** Base image, e.g. "ubuntu-24.04". */
	image: string;
	/** Cloud private-network id to attach the VM to (so it gets a private IP). */
	networkId?: string;
}
