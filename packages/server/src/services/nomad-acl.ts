/**
 * Nomad ACL token management, minted through the panel's MANAGEMENT token
 * (process.env.NOMAD_TOKEN) instead of hand-run `nomad acl` over SSH. Tokens
 * created here are namespaced with a NAME PREFIX so the UI only ever lists or
 * revokes tokens IT created — never the panel's own management token or Nomad's
 * bootstrap token. Reads/writes go to the control-plane Nomad (see
 * [[nomploy-nomad-reads-control-plane]]).
 */

const NOMAD = (process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646").replace(
	/\/$/,
	"",
);
const authHeaders = (
	extra?: Record<string, string>,
): Record<string, string> => {
	const token = process.env.NOMAD_TOKEN || "";
	return { ...(token ? { "X-Nomad-Token": token } : {}), ...(extra ?? {}) };
};

// UI-created tokens carry this Name prefix so list/revoke can be scoped to them.
const UI_PREFIX = "nomploy-ui:";

export type NomadTokenScope = "read" | "deploy";

// Preset policies (idempotently upserted on create). "read" = collect/monitor;
// "deploy" = read + submit jobs (powerful — near-admin for the namespace).
const POLICY: Record<
	NomadTokenScope,
	{ name: string; rules: string; description: string }
> = {
	read: {
		name: "nomploy-ui-readonly",
		description: "nomploy UI: read-only Nomad access",
		rules: `namespace "*" { policy = "read" }\nnode { policy = "read" }\nagent { policy = "read" }`,
	},
	deploy: {
		name: "nomploy-ui-deploy",
		description: "nomploy UI: read + submit (deploy) Nomad access",
		rules: `namespace "*" { policy = "write" }\nnode { policy = "read" }\nagent { policy = "read" }`,
	},
};

const nomadReq = async (
	path: string,
	init?: RequestInit,
): Promise<Response> => {
	const res = await fetch(`${NOMAD}/v1${path}`, {
		...init,
		headers: authHeaders(init?.headers as Record<string, string> | undefined),
	});
	if (!res.ok && res.status !== 404) {
		throw new Error(
			`Nomad ${init?.method ?? "GET"} ${res.status} on ${path}: ${await res
				.text()
				.catch(() => "")}`,
		);
	}
	return res;
};

export interface NomadTokenInfo {
	accessorId: string;
	name: string; // display name (UI prefix stripped)
	scope: string; // bound policy names
	createTime: string | null;
}

/** UI-managed Nomad tokens only (Name starts with the UI prefix). */
export const listNomadTokens = async (): Promise<NomadTokenInfo[]> => {
	const res = await nomadReq("/acl/tokens");
	const rows = (await res.json()) as {
		AccessorID: string;
		Name?: string;
		Policies?: string[];
		CreateTime?: string;
	}[];
	return rows
		.filter((t) => typeof t.Name === "string" && t.Name.startsWith(UI_PREFIX))
		.map((t) => ({
			accessorId: t.AccessorID,
			name: (t.Name as string).slice(UI_PREFIX.length),
			scope: (t.Policies ?? []).join(", "),
			createTime: t.CreateTime ?? null,
		}))
		.sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""));
};

/** Mint a scoped token. Returns the SecretID (shown once, never stored). */
export const createNomadToken = async (
	name: string,
	scope: NomadTokenScope,
): Promise<{ accessorId: string; secretId: string }> => {
	const p = POLICY[scope];
	// Idempotently upsert the preset policy, then create a token bound to it.
	await nomadReq(`/acl/policy/${encodeURIComponent(p.name)}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			Name: p.name,
			Description: p.description,
			Rules: p.rules,
		}),
	});
	const res = await nomadReq("/acl/token", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			Name: `${UI_PREFIX}${name}`,
			Type: "client",
			Policies: [p.name],
		}),
	});
	const t = (await res.json()) as { AccessorID: string; SecretID: string };
	return { accessorId: t.AccessorID, secretId: t.SecretID };
};

/** Revoke a UI-managed token (refuses anything not created by the UI). */
export const deleteNomadToken = async (accessorId: string): Promise<void> => {
	const res = await nomadReq(`/acl/token/${encodeURIComponent(accessorId)}`);
	if (res.status === 404) return;
	const t = (await res.json()) as { Name?: string };
	if (typeof t?.Name !== "string" || !t.Name.startsWith(UI_PREFIX)) {
		throw new Error("Refusing to delete a token not managed by nomploy");
	}
	await nomadReq(`/acl/token/${encodeURIComponent(accessorId)}`, {
		method: "DELETE",
	});
};
