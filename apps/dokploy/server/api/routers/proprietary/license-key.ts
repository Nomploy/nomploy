/**
 * nomploy — free (Apache-2.0) stub of the former enterprise license-key router.
 *
 * nomploy has no commercial licensing, so there is never a valid enterprise
 * license. Queries report the free-tier state and the management mutations are
 * intentionally unavailable.
 */
import { TRPCError } from "@trpc/server";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "../../trpc";

const unavailable = () => {
	throw new TRPCError({
		code: "NOT_IMPLEMENTED",
		message: "Enterprise licensing is not part of nomploy",
	});
};

export const licenseKeyRouter = createTRPCRouter({
	haveValidLicenseKey: protectedProcedure.query(async () => false),
	getEnterpriseSettings: adminProcedure.query(async () => null),
	activate: adminProcedure.mutation(unavailable),
	validate: adminProcedure.mutation(unavailable),
	deactivate: adminProcedure.mutation(unavailable),
	updateEnterpriseSettings: adminProcedure.mutation(unavailable),
});
