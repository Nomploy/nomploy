import type { GetServerSidePropsContext } from "next";

// Metrics moved under Monitoring → Metrics tab. Keep this path as a redirect so
// old links/bookmarks still work.
export default function MetricsRedirect() {
	return null;
}

export async function getServerSideProps(_ctx: GetServerSidePropsContext) {
	return {
		redirect: { permanent: false, destination: "/dashboard/monitoring?tab=metrics" },
	};
}
