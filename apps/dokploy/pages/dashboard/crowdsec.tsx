import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { Crowdsec } from "@/components/dashboard/settings/web-server/crowdsec";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const CrowdsecDashboard = () => {
	return (
		<div className="space-y-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Security</h1>
				<p className="text-sm text-muted-foreground">
					CrowdSec detects malicious traffic from the hub Traefik access log and
					lists the bans it would apply. Detection-only for now — enforcement
					(global or per app/service) ships in a later phase.
				</p>
			</div>
			<Crowdsec />
		</div>
	);
};

export default CrowdsecDashboard;

CrowdsecDashboard.getLayout = (page: ReactElement) => {
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
