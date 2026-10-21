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

// Pure plumbing variables the user never edits — managed by the platform or the
// deployment name. `constraints` is NOT hidden here: it gets a friendly Placement
// control (see placementConstraintsHcl / isPlacementVar) instead of a raw field.
const HIDDEN_VARS = new Set(["job_name", "namespace", "datacenters"]);

// Scalars render as a single input/select; collection/structural kinds
// (map/object/list/set/tuple) render as a raw-HCL textarea so they're editable
// in-form too (resources, extra_env, …) without hand-writing the whole var-file.
const SCALAR_KINDS = new Set(["string", "number", "bool"]);
const STRUCTURED_KINDS = new Set(["map", "object", "list", "set", "tuple"]);

/** `constraints` is surfaced as the Placement control, not a generic field. */
export const isPlacementVar = (v: PackVar) => v.name === "constraints";

/** A scalar variable → one input/select. */
export const isScalar = (v: PackVar) => SCALAR_KINDS.has(v.kind ?? "");

/** A collection/structural variable → a raw-HCL textarea. */
export const isStructured = (v: PackVar) => STRUCTURED_KINDS.has(v.kind ?? "");

export const isEditable = (v: PackVar) =>
	!HIDDEN_VARS.has(v.name) &&
	!isPlacementVar(v) &&
	(isScalar(v) || isStructured(v));

// A variable's `default` is a raw HCL literal: strings are JSON-style quoted
// ("\"immich\""), numbers/bools are bare, collections/objects are an HCL
// expression. Turn it into the value shown in the form field.
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
	// numbers, bools and structured kinds: show the raw HCL default as-is.
	return def;
};

// Turn a form value back into an HCL literal for the var-file.
export const toHclLiteral = (v: PackVar, value: string): string => {
	if (v.kind === "number") return value.trim();
	if (v.kind === "bool") return value === "true" ? "true" : "false";
	// Structured kinds: the field already holds a raw HCL expression — pass it
	// through verbatim (the author edits HCL for a map/object/list).
	if (isStructured(v)) return value.trim();
	return JSON.stringify(value); // string: properly escapes quotes/newlines
};

// ── Placement (the `constraints` variable) ─────────────────────────────────
// A friendly picker over the common node-placement constraint instead of raw
// HCL. "workers" keeps a service OFF the control-plane node (the small hub),
// which is where stateless services otherwise drift and starve the panel's
// zero-downtime roll of memory. Uses the cluster-agnostic control-plane meta.

export type Placement = "any" | "workers";

export const PLACEMENT_OPTIONS: { value: Placement; label: string }[] = [
	{ value: "any", label: "Any node" },
	{ value: "workers", label: "Workers only (keep off the control-plane)" },
];

// The HCL literal for the `constraints` var, or null for "any" (omit the var so
// the pack's own default applies). `$${…}` is deliberate: in the HCL var-file it
// unescapes to `${…}` so Nomad interpolates the node attribute at schedule time.
export const placementConstraintsHcl = (mode: Placement): string | null =>
	mode === "workers"
		? '[{ attribute = "$${meta.nomploy_control_plane}", operator = "!=", value = "true" }]'
		: null;

/** Whether the pack exposes a `constraints` var (→ show the Placement control). */
export const hasConstraintsVar = (variables: PackVar[]) =>
	variables.some((v) => v.name === "constraints");
