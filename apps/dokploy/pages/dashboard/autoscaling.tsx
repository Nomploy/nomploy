import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowAutoscaler } from "@/components/dashboard/nomad/autoscale/show-autoscaler";
import { ShowAutoscalingGraphs } from "@/components/dashboard/nomad/autoscale/show-autoscaling-graphs";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const AutoscalingDashboard = () => {
	return (
		<div className="space-y-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Autoscaling</h1>
				<p className="text-sm text-muted-foreground">
					Node-pool autoscaling groups — each with its own launch template,
					desired count, thresholds, and scheduled actions.
				</p>
			</div>
			<ShowAutoscalingGraphs />
			<ShowAutoscaler />
		</div>
	);
};

export default AutoscalingDashboard;

AutoscalingDashboard.getLayout = (page: ReactElement) => {
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
