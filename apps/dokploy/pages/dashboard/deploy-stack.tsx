import { validateRequest } from "@nomploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { CheckCircle2, Layers, Loader2, XCircle } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import superjson from "superjson";
import { toast } from "sonner";
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
import { slugify } from "@/lib/slug";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

const DEFAULT_REGISTRY = "github.com/Nomploy/nomad-packs";
// The community default registry is addressed by a blank nomadPackRegistry.
const COMMUNITY_REGISTRY =
	"github.com/hashicorp/nomad-pack-community-registry";

// A strong random secret. When the pack's default looks like a fixed-length hex
// token (e.g. a 64-char encryption key), match that so format constraints hold;
// otherwise a 32-char alphanumeric (safe in HCL and in URLs/DSNs).
function genSecret(def: string): string {
	const rand = (n: number) => {
		const a = new Uint8Array(n);
		crypto.getRandomValues(a);
		return a;
	};
	if (/^[0-9a-f]+$/i.test(def) && (def.length === 32 || def.length === 64)) {
		return Array.from(rand(def.length / 2))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}
	const ALPH =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from(rand(32))
		.map((b) => ALPH[b % ALPH.length])
		.join("");
}

const hclEscape = (s: string) =>
	s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

type Phase = "pending" | "creating" | "deploying" | "done" | "error";

/**
 * Landing page for a "Deploy stack to Nomploy" deep-link from a pack registry.
 * The link carries ?packs=a,b,c&registry=<url>(&stack=<id>); the logged-in user
 * picks a project + environment, then every pack is created as a Nomad-Pack
 * service (with auto-generated secrets) and deployed. On completion we jump to
 * the environment where all the new services appear.
 */
const DeployStack = () => {
	const router = useRouter();
	const packs = useMemo(() => {
		const raw = router.query.packs;
		const s = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
		return Array.from(
			new Set(
				s
					.split(",")
					.map((x) => x.trim().toLowerCase())
					.filter((x) => /^[a-z0-9][a-z0-9-]*$/.test(x)),
			),
		);
	}, [router.query.packs]);
	const registry =
		typeof router.query.registry === "string" && router.query.registry
			? router.query.registry
			: DEFAULT_REGISTRY;
	const stackName =
		typeof router.query.stack === "string" ? router.query.stack : "";

	const { data: projects, isLoading } = api.project.all.useQuery();
	const [projectId, setProjectId] = useState("");
	const [environmentId, setEnvironmentId] = useState("");
	const [deployNow, setDeployNow] = useState(true);
	const [running, setRunning] = useState(false);
	const [finished, setFinished] = useState(false);
	const [phases, setPhases] = useState<Record<string, Phase>>({});

	const utils = api.useUtils();
	const createMut = api.compose.create.useMutation();
	const deployMut = api.compose.deploy.useMutation();

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

	useEffect(() => {
		const only = projectList.length === 1 ? projectList[0] : undefined;
		if (!projectId && only) setProjectId(only.projectId);
	}, [projectList, projectId]);
	useEffect(() => {
		const only = environments.length === 1 ? environments[0] : undefined;
		setEnvironmentId(only ? only.environmentId : "");
	}, [projectId]);

	const runDeploy = async () => {
		if (!environmentId || running) return;
		setRunning(true);
		setFinished(false);
		const base = slugify(selectedProject?.name);
		let ok = 0;
		for (const id of packs) {
			setPhases((p) => ({ ...p, [id]: "creating" }));
			try {
				// Auto-generate a value for each sensitive variable so the stack can
				// come up without manual secret entry. Non-secret vars keep their
				// pack defaults; review a service afterwards to customize it.
				let composeFile: string | undefined;
				try {
					const meta = await utils.nomad.getNomadPack.fetch({
						registryUrl: registry,
						id,
					});
					const lines = (meta?.variables ?? [])
						.filter(
							(v) => v.sensitive && (v.kind ?? "string") === "string",
						)
						.map(
							(v) =>
								`${v.name} = "${hclEscape(
									genSecret(String(v.default ?? "")),
								)}"`,
						);
					if (lines.length) composeFile = `${lines.join("\n")}\n`;
				} catch {
					// Registry fetch failed — fall back to the pack's own defaults.
				}

				const created = await createMut.mutateAsync({
					name: id,
					environmentId,
					composeType: "nomad-pack",
					appName: `${base}-${slugify(id)}`,
					nomadPack: id,
					nomadPackRegistry: registry === COMMUNITY_REGISTRY ? "" : registry,
					...(composeFile ? { composeFile } : {}),
				});

				if (deployNow) {
					setPhases((p) => ({ ...p, [id]: "deploying" }));
					await deployMut.mutateAsync({ composeId: created.composeId });
				}
				setPhases((p) => ({ ...p, [id]: "done" }));
				ok++;
			} catch (e) {
				setPhases((p) => ({ ...p, [id]: "error" }));
				toast.error(
					`${id}: ${e instanceof Error ? e.message : "failed"}`,
				);
			}
		}

		await utils.environment.one.invalidate({ environmentId });
		await utils.project.all.invalidate();
		setRunning(false);
		setFinished(true);
		if (ok > 0) {
			toast.success(
				`${ok}/${packs.length} ${deployNow ? "deploying" : "created"} — opening the environment`,
			);
			router.push(
				`/dashboard/project/${projectId}/environment/${environmentId}`,
			);
		}
	};

	if (packs.length === 0) {
		return (
			<div className="mx-auto max-w-xl p-6">
				<Card>
					<CardHeader>
						<CardTitle>No packs specified</CardTitle>
						<CardDescription>
							This page expects a <code>?packs=&lt;a,b,c&gt;</code> query
							parameter, usually from a "Deploy stack to Nomploy" link on a pack
							registry.
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

	const phaseIcon = (id: string) => {
		const ph = phases[id];
		if (ph === "done")
			return <CheckCircle2 className="size-4 text-green-500" />;
		if (ph === "error") return <XCircle className="size-4 text-red-500" />;
		if (ph === "creating" || ph === "deploying")
			return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
		return <span className="size-2 rounded-full bg-muted-foreground/40" />;
	};

	return (
		<div className="mx-auto max-w-xl p-6">
			<Card>
				<CardHeader>
					<div className="flex items-center gap-3">
						<div className="flex size-11 flex-none items-center justify-center rounded-md bg-muted/40">
							<Layers className="size-6 text-muted-foreground" />
						</div>
						<div>
							<CardTitle>
								Deploy {stackName ? `the ${stackName} stack` : "stack"}
							</CardTitle>
							<CardDescription>
								{packs.length} packs will be created as services
								{deployNow ? " and deployed" : ""}. Choose where.
							</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex flex-wrap gap-1.5">
						{packs.map((id) => (
							<span
								key={id}
								className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
							>
								{phaseIcon(id)}
								{id}
							</span>
						))}
					</div>

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
								<Select
									value={projectId}
									onValueChange={setProjectId}
									disabled={running}
								>
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
									disabled={!selectedProject || running}
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

							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={deployNow}
									disabled={running}
									onChange={(e) => setDeployNow(e.target.checked)}
								/>
								Deploy immediately after creating
							</label>

							<p className="text-muted-foreground text-xs">
								Secrets are auto-generated for each pack. Review a service
								afterwards to customize non-secret settings (ports, domains,
								resources).
							</p>

							<Button
								className="w-full"
								disabled={!environmentId || running}
								onClick={runDeploy}
							>
								{running ? (
									<>
										<Loader2 className="mr-2 size-4 animate-spin" />
										Working…
									</>
								) : finished ? (
									"Run again"
								) : (
									`Deploy ${packs.length} packs${deployNow ? "" : " (create only)"}`
								)}
							</Button>
						</>
					)}
				</CardContent>
			</Card>
		</div>
	);
};

export default DeployStack;

DeployStack.getLayout = (page: ReactElement) => {
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
