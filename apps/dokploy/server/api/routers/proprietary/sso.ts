/**
 * nomploy — free (Apache-2.0) stub of the former enterprise SSO router.
 *
 * SSO (OIDC / SAML) is an enterprise feature that nomploy does not ship. The
 * public "should we show the SSO button" checks return false so the login page
 * only offers email / password, and the management endpoints are unavailable.
 */
import { TRPCError } from "@trpc/server";
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from "../../trpc";

const unavailable = () => {
	throw new TRPCError({
		code: "NOT_IMPLEMENTED",
		message: "SSO is not part of nomploy",
	});
};

export const ssoRouter = createTRPCRouter({
	showSignInWithSSO: publicProcedure.query(async () => false),
	enforceSSO: publicProcedure.query(async () => false),
	listProviders: protectedProcedure.query(async () => []),
	getTrustedOrigins: protectedProcedure.query(async () => []),
	one: protectedProcedure.query(async () => null),
	update: protectedProcedure.mutation(unavailable),
	deleteProvider: protectedProcedure.mutation(unavailable),
	register: protectedProcedure.mutation(unavailable),
	addTrustedOrigin: protectedProcedure.mutation(unavailable),
	removeTrustedOrigin: protectedProcedure.mutation(unavailable),
	updateTrustedOrigin: protectedProcedure.mutation(unavailable),
});
