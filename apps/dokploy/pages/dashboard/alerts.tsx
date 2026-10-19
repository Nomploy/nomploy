import type { GetServerSidePropsContext } from "next";

// Alerts moved under Monitoring → Alerts tab. Keep this path as a redirect so
// old links/bookmarks still work.
export default function AlertsRedirect() {
	return null;
}

export async function getServerSideProps(_ctx: GetServerSidePropsContext) {
	return {
		redirect: { permanent: false, destination: "/dashboard/monitoring?tab=alerts" },
	};
}
