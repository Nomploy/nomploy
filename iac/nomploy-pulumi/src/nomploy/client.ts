// Minimal client for the nomploy REST API, plus type-safe helpers generated from
// the OpenAPI spec (see `./api-types`, regenerate with `npm run gen:types`).
//
// The API is the tRPC router surface exposed over HTTP by `@dokploy/trpc-openapi`
// at `<endpoint>/api/<router>.<procedure>`: GET for queries (input flattened into
// query params), POST for mutations (input as a JSON body). Auth is the
// `x-api-key` header. Mint a key in the panel under Settings → API/Swagger
// (or `POST /api/user.createApiKey` from an authenticated session).

export interface Conn {
	/** Base URL of the panel, e.g. https://nomploy.example.com (no trailing /api). */
	endpoint: string;
	/** An API key (x-api-key). */
	apiKey: string;
}

export type Method = "GET" | "POST";

/** Call a tRPC procedure over REST. Throws on a non-2xx response. */
export async function call<T = any>(
	conn: Conn,
	procedure: string,
	input: Record<string, unknown> | undefined,
	method: Method,
): Promise<T> {
	const base = conn.endpoint.replace(/\/+$/, "");
	const url = new URL(`${base}/api/${procedure}`);
	const init: RequestInit = {
		method,
		headers: {
			"x-api-key": conn.apiKey,
			"content-type": "application/json",
		},
	};
	if (method === "GET") {
		for (const [k, v] of Object.entries(input ?? {})) {
			if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
		}
	} else {
		init.body = JSON.stringify(input ?? {});
	}

	const res = await fetch(url.toString(), init);
	const text = await res.text();
	if (!res.ok) {
		throw new Error(
			`nomploy ${method} ${procedure} failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
		);
	}
	return (text ? JSON.parse(text) : undefined) as T;
}

// ─── Typed helpers (from the generated OpenAPI types) ─────────────────────────
// `get`/`post` take a spec path like "/project.create" and type the body/query +
// response from `api-types.ts`. The dynamic providers mostly use the untyped
// `call` above (uniform handling, and the DB provider builds engine paths at
// runtime), but new/typed code can use these.

import type { paths } from "./api-types";

export type ApiPath = keyof paths & string;

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;

/** Request body type for a POST path. */
export type ApiBody<P extends ApiPath> = paths[P] extends {
	post: { requestBody?: infer RB };
}
	? Json<RB>
	: never;

/** Query-params type for a GET path. */
export type ApiQuery<P extends ApiPath> = paths[P] extends {
	get: { parameters: { query?: infer Q } };
}
	? Q
	: never;

/** 200 JSON response type for a path (GET or POST). */
export type ApiResponse<P extends ApiPath> = paths[P] extends {
	get: { responses: { 200: infer R } };
}
	? Json<R>
	: paths[P] extends { post: { responses: { 200: infer R } } }
		? Json<R>
		: never;

const stripSlash = (p: string) => p.replace(/^\/+/, "");

/** Typed GET for a spec path, e.g. `get(conn, "/project.one", { projectId })`. */
export function get<P extends ApiPath>(
	conn: Conn,
	path: P,
	query: ApiQuery<P>,
): Promise<ApiResponse<P>> {
	return call(conn, stripSlash(path), query as any, "GET");
}

/** Typed POST for a spec path, e.g. `post(conn, "/project.create", { name })`. */
export function post<P extends ApiPath>(
	conn: Conn,
	path: P,
	body: ApiBody<P>,
): Promise<ApiResponse<P>> {
	return call(conn, stripSlash(path), body as any, "POST");
}
