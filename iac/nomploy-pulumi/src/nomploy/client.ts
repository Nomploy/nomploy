// Minimal client for the nomploy REST API.
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
