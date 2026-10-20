import { IS_CLOUD } from "@nomploy/server/constants";
import { validateRequest } from "@nomploy/server/lib/auth";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowBackupCoverage } from "@/components/dashboard/backups/show-backup-coverage";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

export default function Backups() {
	return <ShowBackupCoverage />;
}
Backups.getLayout = (page: ReactElement) => {
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
