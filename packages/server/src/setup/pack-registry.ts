// Store metadata published by a GitHub-Pages Nomad-Pack registry (packs.json).
// A brand icon maps to a Simple Icons slug; a monogram is a colored initial
// tile. Health is the smoke-test verdict (null = not boot-tested yet).
export type PackIcon =
	| { kind: "brand"; slug: string; hex?: string; title?: string }
	| { kind: "monogram"; text: string; color?: string };

export type PackHealth = { ok?: boolean; checkedAt?: string } | null;

// A raw pack entry as it appears in a registry's packs.json.
export type RegistryPackRaw = {
	name?: string;
	description?: string;
	version?: string;
	appUrl?: string;
	sourceUrl?: string;
	category?: string;
	stars?: number;
	icon?: PackIcon | null;
	health?: PackHealth | null;
};

// The normalized shape the pack gallery consumes.
export type GalleryPack = {
	name: string;
	description: string;
	version: string;
	url: string;
	category: string;
	stars: number | null;
	icon: PackIcon | null;
	health: PackHealth;
};

/**
 * Normalize a GitHub-Pages registry's packs.json entries into the gallery shape:
 * drop nameless entries, coalesce the homepage (appUrl → sourceUrl), carry the
 * store metadata, and sort most-popular-first (stars desc, then name) so the
 * store opens on the packs people actually use. Packs without a star count sort
 * after starred ones (treated as -1), keeping unknown-popularity packs last.
 */
export const mapRegistryPacks = (packs: RegistryPackRaw[]): GalleryPack[] =>
	packs
		.filter((p) => p.name)
		.map((p) => ({
			name: p.name as string,
			description: p.description ?? "",
			version: p.version ?? "",
			url: p.appUrl || p.sourceUrl || "",
			// Store metadata (GitHub-Pages registries only; null for the host
			// cache-scrape fallback, which parses only metadata.hcl).
			category: p.category ?? "",
			stars: typeof p.stars === "number" ? p.stars : null,
			icon: p.icon ?? null,
			health: p.health ?? null,
		}))
		.sort(
			(a, b) =>
				(b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name),
		);
