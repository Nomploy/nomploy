import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { Observability } from "@/components/dashboard/settings/web-server/observability";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const ObservabilityDashboard = () => {
	return (
		<div className="space-y-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Observability</h1>
				<p className="text-sm text-muted-foreground">
					A managed OpenTelemetry Collector that discovers services via Consul
					and ships their Prometheus metrics to an OTLP backend (e.g. SigNoz),
					with per-service scrape auth profiles.
				</p>
			</div>
			<Observability />
		</div>
	);
};

export default ObservabilityDashboard;

ObservabilityDashboard.getLayout = (page: ReactElement) => {
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
