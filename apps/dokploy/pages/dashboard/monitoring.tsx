import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowAlerts } from "@/components/dashboard/monitoring/show-alerts";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const MonitoringDashboard = () => {
	return (
		<div className="space-y-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Monitoring</h1>
				<p className="text-sm text-muted-foreground">
					Alert rules on your metrics — get notified when a metric crosses a
					threshold. Alerts fan out to every channel with cluster alerts
					enabled.
				</p>
			</div>
			<ShowAlerts />
		</div>
	);
};

export default MonitoringDashboard;

MonitoringDashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	if (IS_CLOUD) {
		return { redirect: { permanent: false, destination: "/dashboard/home" } };
	}
	const { user } = await validateRequest(ctx.req);
	if (!user) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	return { props: {} };
}
