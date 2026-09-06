import { HetznerProvisioner } from "./hetzner";
import type { AutoscaleProviderConfig, NodeProvisioner } from "./provisioner";

export { HetznerProvisioner } from "./hetzner";
export * from "./provisioner";

/** Build the provisioner for a provider config. Add clouds here as implemented. */
export const getProvisioner = (
	cfg: AutoscaleProviderConfig,
): NodeProvisioner => {
	switch (cfg.provider) {
		case "hetzner":
			return new HetznerProvisioner(cfg);
		default:
			throw new Error(`Unsupported autoscale provider: ${cfg.provider}`);
	}
};

/** Providers with a working implementation (for the UI to offer). */
export const SUPPORTED_PROVIDERS = ["hetzner"] as const;
