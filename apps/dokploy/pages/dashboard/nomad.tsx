import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NomadOverview } from "@/components/dashboard/nomad/overview";
import { ShowNomadJobs } from "@/components/dashboard/nomad/jobs/show-nomad-jobs";
import { ShowNomadNodes } from "@/components/dashboard/nomad/nodes/show-nomad-nodes";
import { ShowNomadLogs } from "@/components/dashboard/nomad/logs/show-nomad-logs";

const NomadDashboard = () => {
	return (
		<div className="space-y-4">
			<NomadOverview />
			<Tabs defaultValue="jobs">
				<TabsList>
					<TabsTrigger value="jobs">Jobs</TabsTrigger>
					<TabsTrigger value="nodes">Nodes</TabsTrigger>
					<TabsTrigger value="logs">Logs</TabsTrigger>
				</TabsList>
				<TabsContent value="jobs">
					<ShowNomadJobs />
				</TabsContent>
				<TabsContent value="nodes">
					<ShowNomadNodes />
				</TabsContent>
				<TabsContent value="logs">
					<ShowNomadLogs />
				</TabsContent>
			</Tabs>
		</div>
	);
};

export default NomadDashboard;

NomadDashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext,
) {
	if (IS_CLOUD) {
		return {
			redirect: { permanent: false, destination: "/dashboard/home" },
		};
	}
	const { user } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: { permanent: false, destination: "/" },
		};
	}
	return { props: {} };
}
