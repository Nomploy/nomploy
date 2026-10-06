import {
	createWSClient,
	httpBatchLink,
	httpLink,
	splitLink,
	TRPCClientError,
	wsLink,
} from "@trpc/client";
import { createTRPCNext } from "@trpc/next";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import superjson from "superjson";
import type { AppRouter } from "@/server/api/root";

/**
 * Transient failures are the ones worth retrying during a panel self-update
 * (a Nomad canary roll). While Traefik has no healthy backend it returns
 * 502/503/504, and in-flight requests may fail at the network layer before
 * they ever reach the server. Those should be retried so the user's action
 * survives the cutover. Real 4xx errors (400/401/403/404) are never retried.
 */
export const isTransientError = (error: unknown): boolean => {
	if (error instanceof TRPCClientError) {
		const status = (error as TRPCClientError<AppRouter>).data?.httpStatus;
		if (typeof status === "number") {
			return status >= 500;
		}
		// No tRPC error shape at all (network/parse failure mid-cutover).
		return true;
	}
	// Plain Error/TypeError from a failed fetch — treat as a network failure.
	return true;
};

const getBaseUrl = () => {
	if (typeof window !== "undefined") return "";
	return `http://localhost:${process.env.PORT ?? 3000}`;
};

const getWsUrl = () => {
	if (typeof window === "undefined") return null;

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const host = window.location.host;

	return `${protocol}${host}/drawer-logs`;
};

let wsClientSingleton: ReturnType<typeof createWSClient> | null = null;

const getOrCreateWSClient = () => {
	if (typeof window === "undefined") return null;

	if (!wsClientSingleton) {
		wsClientSingleton = createWSClient({
			url: getWsUrl()!,
			lazy: { enabled: true, closeMs: 3000 },
			retryDelayMs: () => 3000,
		});
	}

	return wsClientSingleton;
};

const wsClient = getOrCreateWSClient();

const links =
	typeof window !== "undefined"
		? [
				splitLink({
					condition: (op) => op.type === "subscription",
					true: wsLink({
						client: wsClient!,
						transformer: superjson,
					}),
					false: splitLink({
						condition: (op) => op.input instanceof FormData,
						true: httpLink({
							url: `${getBaseUrl()}/api/trpc`,
							transformer: superjson,
						}),
						false: httpBatchLink({
							url: `${getBaseUrl()}/api/trpc`,
							transformer: superjson,
						}),
					}),
				}),
			]
		: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
					transformer: superjson,
				}),
			];

export const api = createTRPCNext<AppRouter>({
	config() {
		return {
			links,
			// Retry only transient failures (see isTransientError) so a user's
			// action survives the panel self-update cutover (Traefik 502/503/504
			// or an outright network failure while no backend is healthy).
			// NB: in @trpc/next v11 this lives inside the config() return value
			// (it's forwarded to the internal QueryClient), not alongside config().
			queryClientConfig: {
				defaultOptions: {
					queries: {
						retry: (count, err) => count < 5 && isTransientError(err),
						retryDelay: (count) => Math.min(1000 * 2 ** count, 5000),
					},
					mutations: {
						// A 502 at the LB means the mutation never reached the server,
						// so retrying is safe for the panel-roll cutover case.
						retry: (count, err) => count < 3 && isTransientError(err),
						retryDelay: (count) => Math.min(1000 * 2 ** count, 5000),
					},
				},
			},
		};
	},
	ssr: false,
	transformer: superjson,
});

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
