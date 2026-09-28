import { validateRequest } from "@nomploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { Box, Loader2 } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import superjson from "superjson";
import { AddPack } from "@/components/dashboard/project/add-pack";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

const DEFAULT_REGISTRY = "github.com/Nomploy/nomad-packs";

/**
 * Landing page for a "Deploy to Nomploy" deep-link from a pack registry
 * (e.g. packs.nomploy.com). The link carries ?pack=<id>&registry=<url>; the
 * logged-in user picks a project + environment, then the Nomad Pack configure
 * dialog opens pre-filled with that pack. On success we jump to the environment.
 */
const DeployPack = () => {
	const router = useRouter();
	const pack = typeof router.query.pack === "string" ? router.query.pack : "";
	const registry =
		typeof router.query.registry === "string" && router.query.registry
			? router.query.registry
			: DEFAULT_REGISTRY;

	const { data: projects, isLoading } = api.project.all.useQuery();
	const [projectId, setProjectId] = useState("");
	const [environmentId, setEnvironmentId] = useState("");
	const [mountKey, setMountKey] = useState<number | null>(null);

	const projectList = useMemo(
		() =>
			(projects ?? []).map((p) => ({
				projectId: p.projectId,
				name: p.name,
				environments: (p.environments ?? []).map((e) => ({
					environmentId: e.environmentId,
					name: e.name,
				})),
			})),
		[projects],
	);
	const selectedProject = projectList.find((p) => p.projectId === projectId);
	const environments = selectedProject?.environments ?? [];

	// Preselect when there's an obvious single choice.
	useEffect(() => {
		if (!projectId && projectList.length === 1) {
			setProjectId(projectList[0].projectId);
		}
	}, [projectList, projectId]);
	useEffect(() => {
		setEnvironmentId(
			environments.length === 1 ? environments[0].environmentId : "",
		);
		setMountKey(null);
	}, [projectId]);

	if (!pack) {
		return (
			<div className="mx-auto max-w-xl p-6">
				<Card>
					<CardHeader>
						<CardTitle>No pack specified</CardTitle>
						<CardDescription>
							This page expects a <code>?pack=&lt;id&gt;</code> query parameter,
							usually from a "Deploy to Nomploy" link on a pack registry.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Button onClick={() => router.push("/dashboard/projects")}>
							Go to projects
						</Button>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-xl p-6">
			<Card>
				<CardHeader>
					<div className="flex items-center gap-3">
						<div className="flex size-11 flex-none items-center justify-center rounded-md bg-muted/40">
							{/* biome-ignore lint/performance/noImgElement: external CDN logo */}
							<img
								src={`https://cdn.simpleicons.org/${pack.replace(/[^a-z0-9]+/g, "")}`}
								alt={pack}
								className="size-7 object-contain"
								onError={(e) => {
									(e.currentTarget as HTMLImageElement).style.display = "none";
								}}
							/>
							<Box className="hidden size-6 text-muted-foreground" />
						</div>
						<div>
							<CardTitle>Deploy {pack}</CardTitle>
							<CardDescription>
								Choose where to deploy this Nomad Pack, then configure it.
							</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					{isLoading ? (
						<div className="flex items-center gap-2 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" /> Loading projects…
						</div>
					) : projectList.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							You have no projects yet. Create one first, then come back to this
							link.
						</p>
					) : (
						<>
							<div className="space-y-1.5">
								<Label>Project</Label>
								<Select value={projectId} onValueChange={setProjectId}>
									<SelectTrigger>
										<SelectValue placeholder="Select a project" />
									</SelectTrigger>
									<SelectContent>
										{projectList.map((p) => (
											<SelectItem key={p.projectId} value={p.projectId}>
												{p.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div className="space-y-1.5">
								<Label>Environment</Label>
								<Select
									value={environmentId}
									onValueChange={setEnvironmentId}
									disabled={!selectedProject}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select an environment" />
									</SelectTrigger>
									<SelectContent>
										{environments.map((e) => (
											<SelectItem key={e.environmentId} value={e.environmentId}>
												{e.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<Button
								className="w-full"
								disabled={!environmentId}
								onClick={() => setMountKey(Date.now())}
							>
								Configure &amp; deploy
							</Button>
						</>
					)}
				</CardContent>
			</Card>

			{mountKey && environmentId && (
				<AddPack
					key={mountKey}
					hideTrigger
					defaultOpen
					environmentId={environmentId}
					projectName={selectedProject?.name}
					initialPackName={pack}
					initialRegistryUrl={registry}
					onCreated={() =>
						router.push(
							`/dashboard/project/${projectId}/environment/${environmentId}`,
						)
					}
				/>
			)}
		</div>
	);
};

export default DeployPack;

DeployPack.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { req, res } = ctx;
	const { user, session } = await validateRequest(req);

	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});

	if (!user) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	await helpers.settings.isCloud.prefetch();
	await helpers.user.get.prefetch();
	await helpers.project.all.prefetch();

	return { props: { trpcState: helpers.dehydrate() } };
}
