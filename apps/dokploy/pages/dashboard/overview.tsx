import { validateRequest } from "@nomploy/server/lib/auth";
import { hasPermission } from "@nomploy/server/services/permission";
import { LayoutGrid } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { ShowDeploymentsTable } from "@/components/dashboard/deployments/show-deployments-table";
import { OverviewBackups } from "@/components/dashboard/overview/overview-backups";
import { OverviewDomains } from "@/components/dashboard/overview/overview-domains";
import { OverviewServices } from "@/components/dashboard/overview/overview-services";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";

const TAB_VALUES = ["services", "backups", "domains", "deployments"] as const;
type TabValue = (typeof TAB_VALUES)[number];

const isValidTab = (t: string): t is TabValue =>
	TAB_VALUES.includes(t as TabValue);

function OverviewPage() {
	const router = useRouter();
	const { data: permissions } = api.user.getPermissions.useQuery();

	const canBackups = !!permissions?.backup?.read;
	const canDomains = !!permissions?.domain?.read;
	const canDeployments = !!permissions?.deployment?.read;

	const requested = router.query.tab as string | undefined;
	const tab: TabValue =
		requested && isValidTab(requested) ? requested : "services";

	const setTab = (value: string) => {
		if (!isValidTab(value)) return;
		router.replace(
			{ pathname: "/dashboard/overview", query: { tab: value } },
			undefined,
			{ shallow: true },
		);
	};

	return (
		<div className="w-full">
			<Card className="h-full min-h-[45vh] rounded-xl bg-sidebar p-2.5">
				<div className="h-full rounded-xl bg-background shadow-md">
					<CardHeader>
						<div>
							<CardTitle className="flex items-center gap-2 font-bold text-xl">
								<LayoutGrid className="size-5" />
								Overview
							</CardTitle>
							<CardDescription>
								Every service, domain, backup and deployment across all your
								projects, in one place.
							</CardDescription>
						</div>
						<Tabs value={tab} onValueChange={setTab} className="w-full">
							<TabsList className="mt-2">
								<TabsTrigger value="services">Services</TabsTrigger>
								{canBackups && (
									<TabsTrigger value="backups">Backups</TabsTrigger>
								)}
								{canDomains && (
									<TabsTrigger value="domains">Domains</TabsTrigger>
								)}
								{canDeployments && (
									<TabsTrigger value="deployments">Deployments</TabsTrigger>
								)}
							</TabsList>
							<TabsContent value="services" className="mt-0 pt-4">
								<OverviewServices />
							</TabsContent>
							{canBackups && (
								<TabsContent value="backups" className="mt-0 pt-4">
									<OverviewBackups />
								</TabsContent>
							)}
							{canDomains && (
								<TabsContent value="domains" className="mt-0 pt-4">
									<OverviewDomains />
								</TabsContent>
							)}
							{canDeployments && (
								<TabsContent value="deployments" className="mt-0 pt-4">
									<ShowDeploymentsTable />
								</TabsContent>
							)}
						</Tabs>
					</CardHeader>
				</div>
			</Card>
		</div>
	);
}

export default OverviewPage;

OverviewPage.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	const canView = await hasPermission(
		{
			user: { id: user.id },
			session: { activeOrganizationId: session?.activeOrganizationId || "" },
		},
		{ service: ["read"] },
	);
	if (!canView) {
		return {
			redirect: { permanent: false, destination: "/dashboard/home" },
		};
	}
	return { props: {} };
}
