/**
 * nomploy — free (Apache-2.0) stub of the former enterprise custom-role router.
 *
 * Custom RBAC roles are an enterprise feature. nomploy ships only the static
 * roles (owner / admin / member), so role listings are empty and role
 * management is unavailable.
 */
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "../../trpc";

const unavailable = () => {
	throw new TRPCError({
		code: "NOT_IMPLEMENTED",
		message: "Custom roles are not part of nomploy",
	});
};

export const customRoleRouter = createTRPCRouter({
	all: protectedProcedure.query(
		async () => [] as Array<{ id: string; role: string }>,
	),
	getStatements: protectedProcedure.query(
		async () => [] as Array<{ resource: string; actions: string[] }>,
	),
	membersByRole: protectedProcedure.query(
		async () => [] as Array<{ id: string; email: string; role: string }>,
	),
	create: protectedProcedure.mutation(unavailable),
	update: protectedProcedure.mutation(unavailable),
	remove: protectedProcedure.mutation(unavailable),
});
