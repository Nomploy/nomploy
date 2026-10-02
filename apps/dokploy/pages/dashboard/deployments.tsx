import type { GetServerSidePropsContext } from "next";

// The standalone Deployments page was folded into the cross-project Overview
// (Deployments + Queue tabs). Keep this route as a redirect so old links/bookmarks
// still work.
export default function DeploymentsRedirect() {
	return null;
}

export async function getServerSideProps(_ctx: GetServerSidePropsContext) {
	return {
		redirect: {
			permanent: false,
			destination: "/dashboard/overview?tab=deployments",
		},
	};
}
