// Shared helpers for generating a Nomad-Pack var-file that fills in every
// sensitive variable with a strong random secret, so a pack (or a whole stack
// of packs) can be created and come up without manual secret entry. Used by the
// "Deploy Stack" flows (the deep-link landing page and the in-project dialog).

/**
 * A strong random secret. When the pack's default looks like a fixed-length hex
 * token (e.g. a 64-char encryption key), match that so format constraints hold;
 * otherwise a 32-char alphanumeric (safe in HCL and in URLs/DSNs).
 */
export function genSecret(def: string): string {
	const rand = (n: number) => {
		const a = new Uint8Array(n);
		crypto.getRandomValues(a);
		return a;
	};
	if (/^[0-9a-f]+$/i.test(def) && (def.length === 32 || def.length === 64)) {
		return Array.from(rand(def.length / 2))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}
	const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from(rand(32))
		.map((b) => ALPH[b % ALPH.length])
		.join("");
}

export const hclEscape = (s: string) =>
	s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

type SecretVar = {
	name: string;
	kind?: string;
	default?: string | null;
	sensitive?: boolean;
};

/**
 * Build a pack var-file (HCL `name = "value"` lines) that assigns a freshly
 * generated secret to every sensitive string variable, or `undefined` when the
 * pack has none. Non-secret variables keep their pack defaults.
 */
export function genSecretsVarFile(
	variables: SecretVar[] | undefined | null,
): string | undefined {
	const lines = (variables ?? [])
		.filter((v) => v.sensitive && (v.kind ?? "string") === "string")
		.map(
			(v) => `${v.name} = "${hclEscape(genSecret(String(v.default ?? "")))}"`,
		);
	return lines.length ? `${lines.join("\n")}\n` : undefined;
}
