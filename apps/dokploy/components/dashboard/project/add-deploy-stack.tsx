import {
	ArrowLeft,
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
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
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
import { genSecret, genSecretsVarFile } from "@/lib/pack-secrets";
import {
	displayDefault,
	isEditable,
	type PackVar,
	toHclLiteral,
} from "@/lib/pack-vars";
import { slugify } from "@/lib/slug";
import { api } from "@/utils/api";
import { fmtStars, PackLogo, type PackSummary } from "./add-pack";
import { PackVarFields } from "./pack-var-fields";

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

type PackFacts = {
	ports?: { name: string; port: string }[];
	tasks?: number;
	volumeNames?: string[];
	bundledDb?: boolean;
} | null;

type PackDetail = { variables?: PackVar[]; facts?: PackFacts };

/**
 * Build a pack var-file from the user's edited values: every sensitive variable
 * gets the user's value or, when left blank, a freshly generated secret; every
 * non-secret variable is written only when it differs from the pack default.
 * With empty `vals` this reduces to auto-secrets-only (the fast path).
 */
const buildStackVarFile = (
	variables: PackVar[],
	vals: Record<string, string>,
): string | undefined => {
	const lines: string[] = [];
	for (const v of variables.filter(isEditable)) {
		if (v.sensitive) {
			const cur =
				(vals[v.name] ?? "").trim() || genSecret(String(v.default ?? ""));
			lines.push(`${v.name} = ${toHclLiteral(v, cur)}`);
			continue;
		}
		const def = displayDefault(v);
		const cur = vals[v.name] ?? def;
		if (cur === "" && v.kind !== "string") continue;
		if (cur !== def) lines.push(`${v.name} = ${toHclLiteral(v, cur)}`);
	}
	return lines.length ? `${lines.join("\n")}\n` : undefined;
};

/**
 * Deploy a whole **stack** — several packs at once — into the current
 * environment. The in-project sibling of the `deploy-stack` deep-link landing
 * page: browse a pack registry, multi-select packs, optionally open a per-pack
 * Configure step to review facts and set variables, then create each as a
 * Nomad-Pack service (secrets auto-generated when left blank) and optionally
 * deploy right away. Reuses the single-pack gallery's registry list, logos,
 * cards and variable form.
 */
export const AddDeployStack = ({ environmentId, projectName }: Props) => {
	const utils = api.useUtils();
	const slug = slugify(projectName);
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"browse" | "configure">("browse");
	const [registry, setRegistry] = useState<string>(REGISTRIES[0].url);
	const [custom, setCustom] = useState("");
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState<string>(ALL_CATEGORIES);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [deployNow, setDeployNow] = useState(true);
	const [running, setRunning] = useState(false);
	const [loadingDetails, setLoadingDetails] = useState(false);
	const [finished, setFinished] = useState(false);
	const [phases, setPhases] = useState<Record<string, Phase>>({});
	// Per-pack fetched schema + the user's edited values, keyed by pack name.
	const [details, setDetails] = useState<Record<string, PackDetail>>({});
	const [values, setValues] = useState<Record<string, Record<string, string>>>(
		{},
	);

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
		setStep("browse");
		setSelected(new Set());
		setDetails({});
		setValues({});
		setPhases({});
		setFinished(false);
	};

	const clearSelection = () => {
		setSelected(new Set());
		setDetails({});
		setValues({});
	};

	const toggle = (name: string) =>
		setSelected((s) => {
			const next = new Set(s);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});

	const setVar = (pack: string, name: string, value: string) =>
		setValues((s) => ({ ...s, [pack]: { ...(s[pack] ?? {}), [name]: value } }));

	// Fetch each selected pack's schema, seed non-secret defaults, open Configure.
	const goConfigure = async () => {
		if (selected.size === 0 || loadingDetails) return;
		setLoadingDetails(true);
		try {
			const entries = await Promise.all(
				[...selected].map(async (id) => {
					try {
						return [
							id,
							(await utils.nomad.getNomadPack.fetch({
								registryUrl,
								id,
							})) as PackDetail,
						] as const;
					} catch {
						return [id, null] as const;
					}
				}),
			);
			const nextDetails: Record<string, PackDetail> = {};
			const nextValues = { ...values };
			for (const [id, d] of entries) {
				if (!d) continue;
				nextDetails[id] = d;
				if (!nextValues[id]) {
					const seed: Record<string, string> = {};
					for (const v of (d.variables ?? []).filter(isEditable)) {
						// Leave secrets blank so they auto-generate; seed the rest so the
						// field shows the pack default.
						if (!v.sensitive) seed[v.name] = displayDefault(v);
					}
					nextValues[id] = seed;
				}
			}
			setDetails(nextDetails);
			setValues(nextValues);
			setStep("configure");
		} finally {
			setLoadingDetails(false);
		}
	};

	// Reject a non-numeric value in a number field before creating anything.
	const validate = (): string | null => {
		for (const id of selected) {
			for (const v of (details[id]?.variables ?? []).filter(isEditable)) {
				if (v.kind !== "number") continue;
				const cur = (values[id]?.[v.name] ?? "").trim();
				if (cur !== "" && Number.isNaN(Number(cur)))
					return `${id}: "${v.name}" must be a number`;
			}
		}
		return null;
	};

	const composeFileFor = async (id: string): Promise<string | undefined> => {
		const d = details[id];
		if (d?.variables) return buildStackVarFile(d.variables, values[id] ?? {});
		// Not configured — fetch the schema and auto-generate secrets only.
		try {
			const meta = await utils.nomad.getNomadPack.fetch({ registryUrl, id });
			return genSecretsVarFile(meta?.variables);
		} catch {
			return undefined;
		}
	};

	const deployStack = async () => {
		if (selected.size === 0 || running) return;
		const err = validate();
		if (err) {
			toast.error(err);
			return;
		}
		setRunning(true);
		setFinished(false);
		setPhases({});
		let ok = 0;
		for (const id of selected) {
			setPhases((p) => ({ ...p, [id]: "creating" }));
			try {
				const composeFile = await composeFileFor(id);
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

	const deployLabel = finished
		? "Run again"
		: `Deploy ${selected.size || ""} pack${selected.size === 1 ? "" : "s"}`.trim();

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
				{step === "browse" ? (
					// ── Browse + multi-select ───────────────────────────────────────────
					<>
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
												clearSelection();
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
							<div className="flex gap-2">
								<Button
									variant="secondary"
									onClick={goConfigure}
									disabled={selected.size === 0 || running || loadingDetails}
								>
									{loadingDetails && (
										<Loader2 className="mr-2 size-4 animate-spin" />
									)}
									Configure
								</Button>
								<Button
									onClick={deployStack}
									disabled={selected.size === 0 || running}
								>
									{running && <Loader2 className="mr-2 size-4 animate-spin" />}
									{deployLabel}
								</Button>
							</div>
						</div>
					</>
				) : (
					// ── Configure each selected pack ────────────────────────────────────
					<>
						<DialogHeader className="border-b p-6">
							<DialogTitle>Configure stack</DialogTitle>
							<DialogDescription>
								Review each pack and set its variables. Leave a secret blank to
								auto-generate it.
							</DialogDescription>
						</DialogHeader>

						<ScrollArea className="h-[calc(80vh-13rem)]">
							<div className="p-6">
								<Accordion
									type="multiple"
									defaultValue={[...selected]}
									className="w-full"
								>
									{[...selected].map((id) => {
										const d = details[id];
										const facts = d?.facts;
										const editable = (d?.variables ?? []).filter(isEditable);
										return (
											<AccordionItem key={id} value={id}>
												<AccordionTrigger className="gap-2">
													<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
														{phaseBadge(id)}
														<span className="truncate">{id}</span>
														{typeof facts?.tasks === "number" && (
															<Badge
																variant="secondary"
																className="text-[10px]"
															>
																{facts.tasks} task
																{facts.tasks === 1 ? "" : "s"}
															</Badge>
														)}
														{facts?.bundledDb && (
															<Badge
																variant="secondary"
																className="text-[10px]"
															>
																bundled DB
															</Badge>
														)}
														{(facts?.ports ?? []).slice(0, 4).map((pt) => (
															<Badge
																key={pt.name}
																variant="secondary"
																className="text-[10px]"
															>
																{pt.name}:{pt.port}
															</Badge>
														))}
													</div>
												</AccordionTrigger>
												<AccordionContent>
													{!d ? (
														<AlertBlock type="warning">
															Couldn't load this pack's schema — it will deploy
															with its built-in defaults (secrets
															auto-generated).
														</AlertBlock>
													) : editable.length === 0 ? (
														<AlertBlock type="info">
															This pack exposes no configurable variables here.
															It'll deploy with its built-in defaults.
														</AlertBlock>
													) : (
														<div className="space-y-4">
															<PackVarFields
																variables={d.variables ?? []}
																values={values[id] ?? {}}
																onChange={(name, value) =>
																	setVar(id, name, value)
																}
															/>
														</div>
													)}
												</AccordionContent>
											</AccordionItem>
										);
									})}
								</Accordion>
							</div>
						</ScrollArea>

						<div className="flex items-center justify-between gap-3 border-t p-4">
							<Button
								variant="ghost"
								onClick={() => setStep("browse")}
								disabled={running}
							>
								<ArrowLeft className="mr-2 size-4" />
								Back
							</Button>
							<div className="flex items-center gap-4">
								<label
									htmlFor="deploy-stack-now-cfg"
									className="flex items-center gap-2 text-sm"
								>
									<Checkbox
										id="deploy-stack-now-cfg"
										checked={deployNow}
										disabled={running}
										onCheckedChange={(v) => setDeployNow(v === true)}
									/>
									Deploy immediately
								</label>
								<Button
									onClick={deployStack}
									disabled={selected.size === 0 || running}
								>
									{running && <Loader2 className="mr-2 size-4 animate-spin" />}
									{deployLabel}
								</Button>
							</div>
						</div>
					</>
				)}
				{createMut.isError && (
					<div className="px-4 pb-4">
						<AlertBlock type="error">{createMut.error?.message}</AlertBlock>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
};
