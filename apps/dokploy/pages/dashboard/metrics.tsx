import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowMetrics } from "@/components/dashboard/metrics/show-metrics";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

export default function Metrics() {
	return <ShowMetrics />;
}
Metrics.getLayout = (page: ReactElement) => {
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
