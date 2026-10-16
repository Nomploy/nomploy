// Shared helpers for a Nomad-Pack's variable schema: which variables are
// editable from a form, how to display a default, and how to turn a form value
// back into an HCL literal for the var-file. Used by both the single-pack flow
// (AddPack) and the stack flow (AddDeployStack) so they treat variables
// identically.

export type PackVar = {
	name: string;
	description?: string;
	type?: string;
	kind?: string;
	default?: string;
	placeholder?: boolean;
	sensitive?: boolean;
};

// Plumbing variables the user should never edit from the form — they're managed
// by the platform (constraints/datacenters) or the deployment name (job_name).
const HIDDEN_VARS = new Set([
	"job_name",
	"namespace",
	"datacenters",
	"constraints",
]);
// Only scalar variables get a form field; list/object vars (resources, disks…)
// keep their pack defaults.
const EDITABLE_KINDS = new Set(["string", "number", "bool"]);

export const isEditable = (v: PackVar) =>
	!HIDDEN_VARS.has(v.name) && EDITABLE_KINDS.has(v.kind ?? "");

// A variable's `default` is a raw HCL literal: strings are JSON-style quoted
// ("\"immich\""), numbers/bools are bare. Turn it into a display value.
export const displayDefault = (v: PackVar): string => {
	const def = v.default ?? "";
	if (v.kind === "string") {
		try {
			const parsed = JSON.parse(def);
			return typeof parsed === "string" ? parsed : def;
		} catch {
			return def.replace(/^"|"$/g, "");
		}
	}
	return def;
};

// Turn a form value back into an HCL literal for the var-file.
export const toHclLiteral = (v: PackVar, value: string): string => {
	if (v.kind === "number") return value.trim();
	if (v.kind === "bool") return value === "true" ? "true" : "false";
	return JSON.stringify(value); // properly escapes quotes/newlines
};
