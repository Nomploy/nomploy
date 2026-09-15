import packageInfo from "../package.json";

/**
 * The running panel's version.
 *
 * Prefers NOMPLOY_VERSION, baked into the image at build time from the git ref
 * (Dockerfile ARG → ENV, set by CI). This lets releases avoid bumping
 * package.json — a bump would change the file COPY'd before `pnpm install` and
 * bust that cache layer, forcing a near-cold build on every release. Falls back
 * to package.json for local dev, where it shows a dev version.
 */
export const NOMPLOY_VERSION =
	process.env.NOMPLOY_VERSION || packageInfo.version;
