import { readFileSync } from "node:fs";
import path from "node:path";
import { paths } from "../constants";

// Dependency-light reader of the CrowdSec config's per-service state, kept in its
// OWN leaf module so the job builders (utils/builders/nomad.ts) can import it
// without pulling in setup/crowdsec.ts (which imports traefik-setup → builders,
// i.e. a cycle). Mirrors the config path in crowdsec.ts (crowdsecConfigPath).

/** The file-provider middleware name both Traefik instances define the bouncer as. */
export const CROWDSEC_MIDDLEWARE_REF = "crowdsec@file";

/**
 * True when CrowdSec runs in **per-service** mode and has a bouncer key — i.e. the
 * bouncer is attached per-router via a Consul tag (not globally on the entrypoints),
 * so the builders should emit the per-router `crowdsec@file` middleware tag on each
 * router (unless the service opted out). Deliberately does NOT require `enforce`:
 * the middleware stays defined (as a pass-through when enforce is off) so toggling
 * enforce is an instant file-provider hot-reload with no app re-deploy. Best-effort
 * — returns false on any read/parse error so a missing config never breaks a build.
 */
export const isCrowdsecPerServiceActive = (): boolean => {
	try {
		const file = path.join(
			paths().MAIN_TRAEFIK_PATH,
			"..",
			"crowdsec",
			"config.json",
		);
		const c = JSON.parse(readFileSync(file, "utf8")) as {
			enabled?: boolean;
			perService?: boolean;
			bouncerKey?: string;
		};
		return (
			c.enabled === true &&
			c.perService === true &&
			typeof c.bouncerKey === "string" &&
			c.bouncerKey !== ""
		);
	} catch {
		return false;
	}
};
