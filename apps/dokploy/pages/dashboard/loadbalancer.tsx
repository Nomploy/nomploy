import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowLoadBalancer } from "@/components/dashboard/nomad/loadbalancer/show-loadbalancer";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const LoadBalancerDashboard = () => {
	return (
		<div className="space-y-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Load Balancer</h1>
				<p className="text-sm text-muted-foreground">
					High-availability ingress — Traefik on every node tagged for
					load-balancing, serving routes from Consul and shared certs from
					Consul KV.
				</p>
			</div>
			<ShowLoadBalancer />
		</div>
	);
};

export default LoadBalancerDashboard;

LoadBalancerDashboard.getLayout = (page: ReactElement) => {
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
