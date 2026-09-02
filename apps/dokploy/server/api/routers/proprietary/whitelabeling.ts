/**
 * nomploy — free (Apache-2.0) white-labeling router.
 *
 * Upstream gated white-labeling behind an enterprise license. In nomploy it is
 * a free feature: any organization owner can customize the branding. The stored
 * shape (webServerSettings.whitelabelingConfig) is unchanged.
 */
import {
	getWebServerSettings,
	IS_CLOUD,
	updateWebServerSettings,
} from "@nomploy/server";
import { TRPCError } from "@trpc/server";
import { apiUpdateWhitelabeling } from "@/server/db/schema";
import {
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from "../../trpc";

const EMPTY_CONFIG = {
	appName: null,
	appDescription: null,
	logoUrl: null,
	faviconUrl: null,
	customCss: null,
	loginLogoUrl: null,
	supportUrl: null,
	docsUrl: null,
	errorPageTitle: null,
	errorPageDescription: null,
	metaTitle: null,
	footerText: null,
};

const requireOwner = (role: string) => {
	if (role !== "owner") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only the owner can change branding settings",
		});
	}
};

export const whitelabelingRouter = createTRPCRouter({
	get: protectedProcedure.query(async () => {
		if (IS_CLOUD) return null;
		const settings = await getWebServerSettings();
		return settings?.whitelabelingConfig ?? null;
	}),

	update: protectedProcedure
		.input(apiUpdateWhitelabeling)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Branding is not available in Cloud",
				});
			}
			requireOwner(ctx.user.role);
			await updateWebServerSettings({
				whitelabelingConfig: input.whitelabelingConfig,
			});
			return { success: true };
		}),

	reset: protectedProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Branding is not available in Cloud",
			});
		}
		requireOwner(ctx.user.role);
		await updateWebServerSettings({ whitelabelingConfig: EMPTY_CONFIG });
		return { success: true };
	}),

	// Public endpoint for unauthenticated pages (login, register, error).
	getPublic: publicProcedure.query(async () => {
		if (IS_CLOUD) return null;
		const settings = await getWebServerSettings();
		const config = settings?.whitelabelingConfig;
		if (!config) return null;
		return {
			appName: config.appName,
			appDescription: config.appDescription,
			logoUrl: config.logoUrl,
			loginLogoUrl: config.loginLogoUrl,
			faviconUrl: config.faviconUrl,
			customCss: config.customCss,
			metaTitle: config.metaTitle,
			errorPageTitle: config.errorPageTitle,
			errorPageDescription: config.errorPageDescription,
			footerText: config.footerText,
		};
	}),
});
