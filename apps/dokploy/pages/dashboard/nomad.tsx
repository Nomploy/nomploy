import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import { type ReactElement, useState } from "react";
import { ShowAutoscaler } from "@/components/dashboard/nomad/autoscale/show-autoscaler";
import { ShowCluster } from "@/components/dashboard/nomad/cluster/show-cluster";
import { ShowConsul } from "@/components/dashboard/nomad/consul/show-consul";
import { ShowNomadJobs } from "@/components/dashboard/nomad/jobs/show-nomad-jobs";
import { ShowNomadLogs } from "@/components/dashboard/nomad/logs/show-nomad-logs";
import { ShowNetworkPolicies } from "@/components/dashboard/nomad/network/show-network-policies";
import { ShowNomadNodes } from "@/components/dashboard/nomad/nodes/show-nomad-nodes";
import { NomadOverview } from "@/components/dashboard/nomad/overview";
import { ShowRegistry } from "@/components/dashboard/nomad/registry/show-registry";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";

// Sentinel for the control plane's own local Nomad (no serverId sent).
const LOCAL = "local";

const NomadDashboard = () => {
	const [selected, setSelected] = useState<string>(LOCAL);
	const { data: servers } = api.server.all.useQuery();
	const router = useRouter();

	const serverId = selected === LOCAL ? undefined : selected;

	// Tab is URL-driven so deep links (e.g. the "Autoscaling tab" hint) work.
	const tab = (router.query.tab as string) || "cluster";
	const setTab = (value: string) => {
		router.replace({ query: { ...router.query, tab: value } }, undefined, {
			shallow: true,
		});
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-4">
				<h1 className="text-2xl font-semibold tracking-tight">Nomad</h1>
				<Select value={selected} onValueChange={setSelected}>
					<SelectTrigger className="w-[260px]">
						<SelectValue placeholder="Select a Nomad cluster" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={LOCAL}>Local (control plane)</SelectItem>
						{servers?.map((server) => (
							<SelectItem key={server.serverId} value={server.serverId}>
								{server.name}
								{!server.nomadAddress ? " (no Nomad address)" : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<NomadOverview serverId={serverId} />
			<Tabs value={tab} onValueChange={setTab}>
				<TabsList>
					<TabsTrigger value="cluster">Cluster</TabsTrigger>
					<TabsTrigger value="jobs">Jobs</TabsTrigger>
					<TabsTrigger value="nodes">Nodes</TabsTrigger>
					<TabsTrigger value="consul">Consul</TabsTrigger>
					<TabsTrigger value="network">Network</TabsTrigger>
					<TabsTrigger value="registry">Registry</TabsTrigger>
					<TabsTrigger value="autoscale">Autoscaling</TabsTrigger>
					<TabsTrigger value="logs">Logs</TabsTrigger>
				</TabsList>
				<TabsContent value="cluster">
					<ShowCluster />
				</TabsContent>
				<TabsContent value="jobs">
					<ShowNomadJobs serverId={serverId} />
				</TabsContent>
				<TabsContent value="nodes">
					<ShowNomadNodes serverId={serverId} />
				</TabsContent>
				<TabsContent value="consul">
					<ShowConsul serverId={serverId} />
				</TabsContent>
				<TabsContent value="network">
					<ShowNetworkPolicies />
				</TabsContent>
				<TabsContent value="registry">
					<ShowRegistry />
				</TabsContent>
				<TabsContent value="autoscale">
					<ShowAutoscaler />
				</TabsContent>
				<TabsContent value="logs">
					<ShowNomadLogs serverId={serverId} />
				</TabsContent>
			</Tabs>
		</div>
	);
};

export default NomadDashboard;

NomadDashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
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
