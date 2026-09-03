import type { Domain } from "@nomploy/server/services/domain";
import type { ApplicationNested } from "../builders";
import {
	loadOrCreateConfig,
	loadOrCreateConfigRemote,
	removeTraefikConfig,
	removeTraefikConfigRemote,
	writeTraefikConfig,
	writeTraefikConfigRemote,
} from "./application";
import type { FileConfig, HttpRouter } from "./file-types";
import { removePathMiddlewares } from "./middleware";

// Application routing is now handled by the Nomad job's Consul-catalog tags
// (see builders/nomad-application). A Traefik file router for the app would
// shadow the Consul router with a stale backend (the old Swarm service name),
// so on any domain change we make sure the legacy file config is gone instead of
// writing one. The `domain` arg is kept for the call sites' signature.
export const manageDomain = async (app: ApplicationNested, _domain: Domain) => {
	const { appName, serverId } = app;
	if (serverId) {
		await removeTraefikConfigRemote(appName, serverId);
	} else {
		await removeTraefikConfig(appName);
	}
};

export const removeDomain = async (
	application: ApplicationNested,
	uniqueKey: number,
) => {
	const { appName, serverId } = application;
	let config: FileConfig;

	if (serverId) {
		config = await loadOrCreateConfigRemote(serverId, appName);
	} else {
		config = loadOrCreateConfig(appName);
	}

	const routerKey = `${appName}-router-${uniqueKey}`;
	const routerSecureKey = `${appName}-router-websecure-${uniqueKey}`;

	const serviceKey = `${appName}-service-${uniqueKey}`;
	if (config.http?.routers?.[routerKey]) {
		delete config.http.routers[routerKey];
	}
	if (config.http?.routers?.[routerSecureKey]) {
		delete config.http.routers[routerSecureKey];
	}
	if (config.http?.services?.[serviceKey]) {
		delete config.http.services[serviceKey];
	}

	await removePathMiddlewares(application, uniqueKey);

	// verify if is the last router if so we delete the router
	if (
		config?.http?.routers &&
		Object.keys(config?.http?.routers).length === 0
	) {
		if (serverId) {
			await removeTraefikConfigRemote(appName, serverId);
		} else {
			await removeTraefikConfig(appName);
		}
	} else {
		if (serverId) {
			await writeTraefikConfigRemote(config, appName, serverId);
		} else {
			writeTraefikConfig(config, appName);
		}
	}
};

/**
 * Converts an internationalized domain name (IDN) to ASCII punycode format.
 * Traefik requires domain names in ASCII format, so non-ASCII characters
 * must be converted (e.g., "тест.рф" → "xn--e1aybc.xn--p1ai").
 */
const toPunycode = (host: string): string => {
	try {
		return new URL(`http://${host}`).hostname;
	} catch {
		// If URL parsing fails, return the original host
		return host;
	}
};

export const createRouterConfig = async (
	app: ApplicationNested,
	domain: Domain,
	entryPoint: string,
) => {
	const { appName, redirects, security } = app;
	const { certificateType } = domain;

	const {
		host,
		path,
		https,
		uniqueConfigKey,
		internalPath,
		stripPath,
		customEntrypoint,
	} = domain;
	const punycodeHost = toPunycode(host);
	const routerConfig: HttpRouter = {
		rule: `Host(\`${punycodeHost}\`)${path !== null && path !== "/" ? ` && PathPrefix(\`${path}\`)` : ""}`,
		service: `${appName}-service-${uniqueConfigKey}`,
		middlewares: [],
		entryPoints: [entryPoint],
	};

	const isRedirectRouter = entryPoint === "web" && https && !customEntrypoint;

	// Web router with HTTPS only needs redirect — all other middlewares
	// run on the websecure router where the request actually lands.
	if (isRedirectRouter) {
		routerConfig.middlewares?.push("redirect-to-https");
	} else {
		// Add path rewriting middleware if needed
		// stripPrefix must come before addPrefix so Traefik strips the
		// public path first, then prepends the internal path.
		if (stripPath && path && path !== "/") {
			const stripMiddleware = `stripprefix-${appName}-${uniqueConfigKey}`;
			routerConfig.middlewares?.push(stripMiddleware);
		}

		if (internalPath && internalPath !== "/" && internalPath !== path) {
			const pathMiddleware = `addprefix-${appName}-${uniqueConfigKey}`;
			routerConfig.middlewares?.push(pathMiddleware);
		}

		// redirects - skip for preview deployments as wildcard subdomains
		// should not inherit parent redirect rules (e.g., www-redirect)
		if (domain.domainType !== "preview") {
			for (const redirect of redirects) {
				const middlewareName = `redirect-${appName}-${redirect.uniqueConfigKey}`;
				routerConfig.middlewares?.push(middlewareName);
			}
		}

		// security
		if (security.length > 0) {
			let middlewareName = `auth-${appName}`;
			if (domain.domainType === "preview") {
				middlewareName = `auth-${appName.replace(
					/^preview-(.+)-[^-]+$/,
					"$1",
				)}`;
			}
			routerConfig.middlewares?.push(middlewareName);
		}

		// custom middlewares from domain
		if (domain.middlewares && domain.middlewares.length > 0) {
			routerConfig.middlewares?.push(...domain.middlewares);
		}
	}

	if (entryPoint === "websecure" || (customEntrypoint && https)) {
		if (certificateType === "letsencrypt") {
			routerConfig.tls = { certResolver: "letsencrypt" };
		} else if (certificateType === "custom" && domain.customCertResolver) {
			routerConfig.tls = { certResolver: domain.customCertResolver };
		} else if (certificateType === "none") {
			routerConfig.tls = undefined;
		}
	}

	return routerConfig;
};
