import {
	mapRegistryPacks,
	type RegistryPackRaw,
} from "@nomploy/server/setup/pack-registry";
import { describe, expect, it } from "vitest";

describe("mapRegistryPacks — gallery normalization + sort", () => {
	it("sorts most-popular-first (stars desc), unknown stars last", () => {
		const raw: RegistryPackRaw[] = [
			{ name: "beta", stars: 10 },
			{ name: "alpha", stars: 500 },
			{ name: "nostars" },
			{ name: "gamma", stars: 500 },
		];
		const out = mapRegistryPacks(raw).map((p) => p.name);
		// 500-star packs first (alpha/gamma, name tiebreak), then 10, then unknown.
		expect(out).toEqual(["alpha", "gamma", "beta", "nostars"]);
	});

	it("drops nameless entries", () => {
		const out = mapRegistryPacks([
			{ description: "no name" },
			{ name: "keep" },
		]);
		expect(out).toHaveLength(1);
		expect(out[0]?.name).toBe("keep");
	});

	it("coalesces homepage appUrl → sourceUrl → empty", () => {
		const out = mapRegistryPacks([
			{ name: "a", appUrl: "https://app", sourceUrl: "https://src" },
			{ name: "b", sourceUrl: "https://src-only" },
			{ name: "c" },
		]);
		const by = Object.fromEntries(out.map((p) => [p.name, p.url]));
		expect(by.a).toBe("https://app");
		expect(by.b).toBe("https://src-only");
		expect(by.c).toBe("");
	});

	it("carries store metadata and defaults missing fields", () => {
		const [p] = mapRegistryPacks([
			{
				name: "grafana",
				category: "Observability",
				stars: 60000,
				icon: { kind: "brand", slug: "grafana", hex: "#F46800" },
				health: { ok: true, checkedAt: "2026-10-01" },
			},
		]);
		expect(p).toMatchObject({
			name: "grafana",
			category: "Observability",
			stars: 60000,
			icon: { kind: "brand", slug: "grafana" },
			health: { ok: true },
		});

		const [bare] = mapRegistryPacks([{ name: "bare" }]);
		expect(bare).toMatchObject({
			category: "",
			stars: null,
			icon: null,
			health: null,
		});
	});

	it("treats a non-numeric stars value as unknown (null)", () => {
		const [p] = mapRegistryPacks([
			{ name: "x", stars: undefined as unknown as number },
		]);
		expect(p?.stars).toBeNull();
	});
});
