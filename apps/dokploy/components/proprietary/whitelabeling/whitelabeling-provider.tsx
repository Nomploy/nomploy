/**
 * nomploy — applies the public branding config (meta title, favicon, custom CSS)
 * to unauthenticated and authenticated pages alike. This is a free feature.
 */
"use client";

import Head from "next/head";
import { api } from "@/utils/api";

export function WhitelabelingProvider() {
	const { data: config } = api.whitelabeling.getPublic.useQuery(undefined, {
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});

	if (!config) return null;

	return (
		<>
			<Head>
				{config.metaTitle && <title>{config.metaTitle}</title>}
				{config.faviconUrl && <link rel="icon" href={config.faviconUrl} />}
			</Head>
			{config.customCss && (
				<style
					id="whitelabeling-styles"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: owner-provided branding CSS
					dangerouslySetInnerHTML={{ __html: config.customCss }}
				/>
			)}
		</>
	);
}
