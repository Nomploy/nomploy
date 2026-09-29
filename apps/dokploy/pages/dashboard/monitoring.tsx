import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import { hasPermission } from "@nomploy/server/services/permission";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { NomadMonitoring } from "@/components/dashboard/monitoring/nomad-monitoring";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const Dashboard = () => {
	return (
		<div className="space-y-4 pb-10">
			<div className="flex flex-col gap-1">
				<h1 className="font-bold text-2xl">Monitoring</h1>
				<p className="text-muted-foreground text-sm">
					Live utilization of the Nomad cluster — capacity, reservations and
					real usage per node, and your heaviest projects. For cluster
					management (jobs, nodes, autoscaler) see the{" "}
					<a href="/dashboard/nomad" className="underline">
						Nomad
					</a>{" "}
					tab.
				</p>
			</div>
			<NomadMonitoring />
		</div>
	);
};

export default Dashboard;

Dashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	if (IS_CLOUD) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}

	const canView = await hasPermission(
		{
			user: { id: user.id },
			session: { activeOrganizationId: session?.activeOrganizationId || "" },
		},
		{ monitoring: ["read"] },
	);

	if (!canView) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}

	return {
		props: {},
	};
}
