import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { SuggestionsList } from "@/components/dashboard/projects/scaling-suggestions";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const SuggestionsDashboard = () => {
	return (
		<div className="space-y-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">
					Utilization suggestions
				</h1>
				<p className="text-sm text-muted-foreground">
					Over-provisioned, running-hot, and idle services from the last 24h of
					sampled metrics. A daily digest of the same analysis is sent to your
					cluster-alert notification channels.
				</p>
			</div>
			<SuggestionsList />
		</div>
	);
};

export default SuggestionsDashboard;

SuggestionsDashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user } = await validateRequest(ctx.req);
	if (!user) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	return { props: {} };
}
