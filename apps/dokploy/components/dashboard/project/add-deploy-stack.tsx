import {
	CheckCircle2,
	Layers,
	Loader2,
	SearchIcon,
	Star,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { genSecretsVarFile } from "@/lib/pack-secrets";
import { slugify } from "@/lib/slug";
import { api } from "@/utils/api";
import { fmtStars, PackLogo, type PackSummary } from "./add-pack";

interface Props {
	environmentId: string;
	projectName?: string;
}

// A Nomad Pack registry is a git repo of packs (same set the single-pack flow
// offers). Default to Nomploy's own curated registry.
const REGISTRIES = [
	{ label: "Nomploy packs", url: "github.com/Nomploy/nomad-packs" },
	{
		label: "Community (HashiCorp)",
		url: "github.com/hashicorp/nomad-pack-community-registry",
	},
	{ label: "Custom…", url: "__custom__" },
] as const;
// The community default registry is addressed by a blank nomadPackRegistry.
const COMMUNITY_REGISTRY = REGISTRIES[1].url;

const ALL_CATEGORIES = "__all__";

type Phase = "creating" | "deploying" | "done" | "error";

/**
 * Deploy a whole **stack** — several packs at once — into the current
 * environment. The in-project sibling of the `deploy-stack` deep-link landing
 * page: browse a pack registry, multi-select packs, and create each as a
 * Nomad-Pack service (with auto-generated secrets), optionally deploying right
 * away. Reuses the single-pack gallery's registry list, logos and card layout.
 */
export const AddDeployStack = ({ environmentId, projectName }: Props) => {
	const utils = api.useUtils();
	const slug = slugify(projectName);
	const [open, setOpen] = useState(false);
	const [registry, setRegistry] = useState<string>(REGISTRIES[0].url);
	const [custom, setCustom] = useState("");
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState<string>(ALL_CATEGORIES);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [deployNow, setDeployNow] = useState(true);
	const [running, setRunning] = useState(false);
	const [finished, setFinished] = useState(false);
	const [phases, setPhases] = useState<Record<string, Phase>>({});

	const registryUrl = registry === "__custom__" ? custom.trim() : registry;
	const { data: packs, isFetching } = api.nomad.listNomadPacks.useQuery(
		{ registryUrl: registryUrl || undefined },
		{ enabled: open && !!registryUrl },
	);
	const createMut = api.compose.create.useMutation();
	const deployMut = api.compose.deploy.useMutation();

	const categories = useMemo(
		() =>
			Array.from(
				new Set(
					(packs ?? []).map((p) => p.category).filter(Boolean) as string[],
				),
			).sort((a, b) => a.localeCompare(b)),
		[packs],
	);

	const q = search.toLowerCase();
	const filtered = (packs ?? []).filter((p) => {
		if (category !== ALL_CATEGORIES && (p.category ?? "") !== category)
			return false;
		return (
			p.name.toLowerCase().includes(q) ||
			p.description.toLowerCase().includes(q)
		);
	});

	const reset = () => {
		setSelected(new Set());
		setPhases({});
		setFinished(false);
	};

	const toggle = (name: string) =>
		setSelected((s) => {
			const next = new Set(s);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});

	const deployStack = async () => {
		if (selected.size === 0 || running) return;
		setRunning(true);
		setFinished(false);
		setPhases({});
		let ok = 0;
		for (const id of selected) {
			setPhases((p) => ({ ...p, [id]: "creating" }));
			try {
				// Auto-generate a value for each sensitive variable so the stack can
				// come up without manual secret entry; non-secret vars keep their
				// pack defaults (review a service afterwards to customize it).
				let composeFile: string | undefined;
				try {
					const meta = await utils.nomad.getNomadPack.fetch({
						registryUrl: registryUrl,
						id,
					});
					composeFile = genSecretsVarFile(meta?.variables);
				} catch {
					// Registry fetch failed — fall back to the pack's own defaults.
				}

				const created = await createMut.mutateAsync({
					name: id,
					environmentId,
					composeType: "nomad-pack",
					appName: `${slug}-${slugify(id)}`,
					nomadPack: id,
					nomadPackRegistry:
						registryUrl === COMMUNITY_REGISTRY ? "" : registryUrl,
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
				toast.error(`${id}: ${e instanceof Error ? e.message : "failed"}`);
			}
		}

		await utils.environment.one.invalidate({ environmentId });
		await utils.project.all.invalidate();
		setRunning(false);
		setFinished(true);
		if (ok > 0) {
			toast.success(
				`${ok}/${selected.size} ${deployNow ? "deploying" : "created"}`,
			);
			if (ok === selected.size) setOpen(false);
		}
	};

	const phaseBadge = (name: string) => {
		const ph = phases[name];
		if (ph === "done")
			return <CheckCircle2 className="size-4 text-green-500" />;
		if (ph === "error") return <XCircle className="size-4 text-red-500" />;
		if (ph === "creating" || ph === "deploying")
			return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
		return null;
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (!o) reset();
			}}
		>
			<DialogTrigger className="w-full">
				<DropdownMenuItem
					className="w-full cursor-pointer space-x-3"
					onSelect={(e) => e.preventDefault()}
				>
					<Layers className="size-4 text-muted-foreground" />
					<span>Deploy Stack</span>
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="p-0 sm:max-w-[70vw]">
				<DialogHeader className="border-b p-6">
					<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
						<div>
							<DialogTitle>Deploy a stack</DialogTitle>
							<DialogDescription>
								Pick several packs and create them all as services in this
								environment at once.
							</DialogDescription>
						</div>
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
							<div className="space-y-1.5">
								<Label className="text-xs">Registry</Label>
								<Select
									value={registry}
									onValueChange={(v) => {
										setRegistry(v);
										setSearch("");
										setCategory(ALL_CATEGORIES);
										setSelected(new Set());
									}}
								>
									<SelectTrigger className="w-full sm:w-[200px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{REGISTRIES.map((r) => (
											<SelectItem key={r.url} value={r.url}>
												{r.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							{registry === "__custom__" && (
								<div className="space-y-1.5">
									<Label className="text-xs">Custom URL</Label>
									<Input
										placeholder="github.com/org/nomad-packs"
										value={custom}
										onChange={(e) => setCustom(e.target.value)}
										className="w-full sm:w-[220px]"
									/>
								</div>
							)}
							{categories.length > 0 && (
								<div className="space-y-1.5">
									<Label className="text-xs">Category</Label>
									<Select value={category} onValueChange={setCategory}>
										<SelectTrigger className="w-full sm:w-[160px]">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ALL_CATEGORIES}>
												All categories
											</SelectItem>
											{categories.map((c) => (
												<SelectItem key={c} value={c}>
													{c}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}
							<div className="space-y-1.5">
								<Label className="text-xs">Search</Label>
								<Input
									placeholder="Search packs…"
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									className="w-full sm:w-[200px]"
								/>
							</div>
						</div>
					</div>
				</DialogHeader>

				<ScrollArea className="h-[calc(80vh-13rem)]">
					<div className="p-6">
						{isFetching ? (
							<div className="flex min-h-[40vh] items-center justify-center gap-3 text-muted-foreground">
								<Loader2 className="size-6 animate-spin" />
								<span className="text-sm">Loading packs…</span>
							</div>
						) : filtered.length === 0 ? (
							<div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-muted-foreground">
								<SearchIcon className="size-6" />
								<p className="text-sm">
									No packs found (is nomad-pack available and the registry
									reachable?).
								</p>
							</div>
						) : (
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
								{filtered.map((p: PackSummary) => {
									const isSel = selected.has(p.name);
									return (
										<button
											type="button"
											key={p.name}
											onClick={() => !running && toggle(p.name)}
											className={`flex flex-col gap-3 rounded-lg border p-4 text-left transition-colors hover:border-primary/50 ${
												isSel ? "border-primary ring-1 ring-primary" : ""
											}`}
										>
											<div className="flex items-start gap-3">
												<Checkbox
													checked={isSel}
													className="mt-1"
													tabIndex={-1}
												/>
												<div className="flex size-10 flex-none items-center justify-center rounded-md bg-muted/40">
													<PackLogo name={p.name} icon={p.icon} />
												</div>
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-2">
														<span className="truncate font-medium text-sm">
															{p.name}
														</span>
														{phaseBadge(p.name)}
													</div>
													<div className="mt-1 flex flex-wrap items-center gap-1.5">
														{typeof p.stars === "number" && (
															<span className="inline-flex items-center gap-0.5 text-muted-foreground text-xs">
																<Star className="size-3 fill-current text-amber-400" />
																{fmtStars(p.stars)}
															</span>
														)}
														{p.category && (
															<Badge
																variant="secondary"
																className="px-1.5 py-0 text-[10px]"
															>
																{p.category}
															</Badge>
														)}
													</div>
												</div>
											</div>
											<p className="line-clamp-2 min-h-[2.5rem] text-muted-foreground text-xs">
												{p.description || "No description provided."}
											</p>
										</button>
									);
								})}
							</div>
						)}
					</div>
				</ScrollArea>

				<div className="flex items-center justify-between gap-3 border-t p-4">
					<div className="flex items-center gap-4">
						<span className="text-muted-foreground text-sm">
							{selected.size} selected
						</span>
						<label
							htmlFor="deploy-stack-now"
							className="flex items-center gap-2 text-sm"
						>
							<Checkbox
								id="deploy-stack-now"
								checked={deployNow}
								disabled={running}
								onCheckedChange={(v) => setDeployNow(v === true)}
							/>
							Deploy immediately
						</label>
					</div>
					<Button
						onClick={deployStack}
						disabled={selected.size === 0 || running}
					>
						{running && <Loader2 className="mr-2 size-4 animate-spin" />}
						{finished
							? "Run again"
							: `Deploy ${selected.size || ""} pack${
									selected.size === 1 ? "" : "s"
								}`.trim()}
					</Button>
				</div>
				{createMut.isError && (
					<div className="px-4 pb-4">
						<AlertBlock type="error">{createMut.error?.message}</AlertBlock>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
};
