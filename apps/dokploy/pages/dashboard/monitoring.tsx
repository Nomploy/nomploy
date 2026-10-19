import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import { hasPermission } from "@nomploy/server/services/permission";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { NomadMonitoring } from "@/components/dashboard/monitoring/nomad-monitoring";
import { ShowAlerts } from "@/components/dashboard/monitoring/show-alerts";
import { ShowMetrics } from "@/components/dashboard/metrics/show-metrics";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/ui/tabs";

const TABS = ["overview", "metrics", "alerts"] as const;

const Dashboard = () => {
	const router = useRouter();
	const tab = TABS.includes(router.query.tab as (typeof TABS)[number])
		? (router.query.tab as string)
		: "overview";
	const setTab = (t: string) =>
		router.replace(
			{ pathname: "/dashboard/monitoring", query: { tab: t } },
			undefined,
			{ shallow: true },
		);

	return (
		<div className="space-y-4 pb-10">
			<div className="flex flex-col gap-1">
				<h1 className="font-bold text-2xl">Monitoring</h1>
				<p className="text-muted-foreground text-sm">
					Cluster utilization, metric dashboards and alert rules — one place.
					For cluster management (jobs, nodes, autoscaler) see the{" "}
					<a href="/dashboard/nomad" className="underline">
						Nomad
					</a>{" "}
					tab.
				</p>
			</div>
			<Tabs value={tab} onValueChange={setTab}>
				<TabsList>
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="metrics">Metrics</TabsTrigger>
					<TabsTrigger value="alerts">Alerts</TabsTrigger>
				</TabsList>
				<TabsContent value="overview" className="pt-4">
					<NomadMonitoring />
				</TabsContent>
				<TabsContent value="metrics" className="pt-4">
					<ShowMetrics />
				</TabsContent>
				<TabsContent value="alerts" className="pt-4">
					<ShowAlerts />
				</TabsContent>
			</Tabs>
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
