import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowCertExpiry } from "@/components/dashboard/security/show-cert-expiry";
import { Crowdsec } from "@/components/dashboard/settings/web-server/crowdsec";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const CrowdsecDashboard = () => {
	return (
		<div className="space-y-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Security</h1>
				<p className="text-sm text-muted-foreground">
					CrowdSec detects malicious traffic from the hub Traefik access log.
					Detection-only by default; turn on Enforce to block banned IPs on the
					load balancer (the WireGuard subnet and allowlist always bypass it).
				</p>
			</div>
			<ShowCertExpiry />
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
