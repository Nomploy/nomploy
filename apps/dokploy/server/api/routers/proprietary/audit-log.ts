/**
 * nomploy — free (Apache-2.0) stub of the former enterprise audit-log router.
 *
 * Audit logging is an enterprise feature that nomploy does not ship, so this
 * always returns an empty result set.
 */
import { createTRPCRouter, protectedProcedure } from "../../trpc";

export const auditLogRouter = createTRPCRouter({
	all: protectedProcedure.query(async () => ({ logs: [], total: 0 })),
});
