import {
	ArrowLeft,
	Box,
	CheckCircle2,
	ExternalLink,
	Loader2,
	SearchIcon,
	Star,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { slugify } from "@/lib/slug";
import { api } from "@/utils/api";

interface Props {
	environmentId: string;
	projectName?: string;
	// Deep-link support (e.g. a "Deploy to Nomploy" link from the registry site):
	// open straight into this pack's configure step.
	defaultOpen?: boolean;
	initialPackName?: string;
	initialRegistryUrl?: string;
	// When rendered outside a dropdown menu (e.g. the deploy-pack landing page),
	// hide the DropdownMenuItem trigger and drive the dialog via defaultOpen.
	hideTrigger?: boolean;
	// Called after a service is successfully created (lets a host page redirect).
	onCreated?: () => void;
}

// A Nomad Pack registry is a git repo of packs. Default to Nomploy's own; the
// HashiCorp community registry has many more; or paste a custom git URL.
const REGISTRIES = [
	{ label: "Nomploy packs", url: "github.com/Nomploy/nomad-packs" },
	{
		label: "Community (HashiCorp)",
		url: "github.com/hashicorp/nomad-pack-community-registry",
	},
	{ label: "Custom…", url: "__custom__" },
] as const;

// Brand logos come from Simple Icons' CDN, keyed by a slug derived from the pack
// name. Most packs are named after the tool (redis, grafana, traefik…) so this
// hits often; when it 404s we fall back to a generic box icon. A few pack names
// differ from their Simple Icons slug — map those explicitly.
const LOGO_ALIASES: Record<string, string> = {
	postgres: "postgresql",
	postgresql: "postgresql",
	mariadb: "mariadb",
	mongo: "mongodb",
	mongodb: "mongodb",
	elasticsearch: "elasticsearch",
	rabbitmq: "rabbitmq",
};

const logoSlug = (name: string) => {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.trim();
	return LOGO_ALIASES[base] ?? base;
};

// Icon published by the registry: a brand (→ Simple Icons slug), a custom
// inline logo (→ data-URI src), or a colored monogram tile. Older/custom
// registries omit it — fall back to guessing a Simple Icons slug from the pack
// name, then a generic box.
type PackIcon =
	| { kind: "brand"; slug: string; hex?: string; title?: string }
	| { kind: "custom"; src: string }
	| { kind: "monogram"; text: string; color?: string };

const PackLogo = ({ name, icon }: { name: string; icon?: PackIcon | null }) => {
	const [errored, setErrored] = useState(false);

	// Custom: a self-contained logo the registry published as a data-URI.
	if (icon?.kind === "custom" && icon.src) {
		return (
			// biome-ignore lint/performance/noImgElement: inline data-URI logo, no next/image
			<img src={icon.src} alt={name} className="size-8 object-contain" />
		);
	}

	// Monogram: a colored initial tile, no network fetch.
	if (icon?.kind === "monogram") {
		return (
			<div
				className="flex size-8 items-center justify-center rounded font-semibold text-sm text-white"
				style={{ backgroundColor: icon.color || "#6b7280" }}
			>
				{icon.text?.slice(0, 2) || name.slice(0, 1).toUpperCase()}
			</div>
		);
	}

	// Brand (from registry) or name-guess: Simple Icons CDN.
	const slug = icon?.kind === "brand" ? icon.slug : logoSlug(name);
	if (!errored && slug) {
		return (
			// biome-ignore lint/performance/noImgElement: external CDN logo, no next/image
			<img
				src={`https://cdn.simpleicons.org/${slug}`}
				alt={name}
				className="size-8 object-contain"
				onError={() => setErrored(true)}
			/>
		);
	}
	// Last resort: a monogram built from the name (so brand 404s still look good).
	return (
		<div className="flex size-8 items-center justify-center rounded bg-muted font-semibold text-muted-foreground text-sm">
			{name.slice(0, 1).toUpperCase() || <Box className="size-5" />}
		</div>
	);
};

// Plumbing variables the user should never edit from the form — they're managed
// by the platform (constraints/datacenters) or the deployment name (job_name).
const HIDDEN_VARS = new Set([
	"job_name",
	"namespace",
	"datacenters",
	"constraints",
]);
// Only scalar variables get a form field; list/object vars (resources, disks…)
// keep their pack defaults.
const EDITABLE_KINDS = new Set(["string", "number", "bool"]);

type PackVar = {
	name: string;
	description?: string;
	type?: string;
	kind?: string;
	default?: string;
	placeholder?: boolean;
	sensitive?: boolean;
};

const isEditable = (v: PackVar) =>
	!HIDDEN_VARS.has(v.name) && EDITABLE_KINDS.has(v.kind ?? "");

// A variable's `default` is a raw HCL literal: strings are JSON-style quoted
// ("\"immich\""), numbers/bools are bare. Turn it into a display value.
const displayDefault = (v: PackVar): string => {
	const def = v.default ?? "";
	if (v.kind === "string") {
		try {
			const parsed = JSON.parse(def);
			return typeof parsed === "string" ? parsed : def;
		} catch {
			return def.replace(/^"|"$/g, "");
		}
	}
	return def;
};

// Turn a form value back into an HCL literal for the var-file.
const toHclLiteral = (v: PackVar, value: string): string => {
	if (v.kind === "number") return value.trim();
	if (v.kind === "bool") return value === "true" ? "true" : "false";
	return JSON.stringify(value); // properly escapes quotes/newlines
};

type PackHealth = { ok?: boolean; checkedAt?: string } | null;

type PackSummary = {
	name: string;
	description: string;
	version: string;
	url: string;
	category?: string;
	stars?: number | null;
	icon?: PackIcon | null;
	health?: PackHealth;
};

// "4172" → "4.2k". Keeps star counts compact on the card.
const fmtStars = (n: number): string =>
	n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;

const ALL_CATEGORIES = "__all__";

/**
 * Browse a Nomad Pack registry, configure a pack's variables, and deploy it —
 * the pack equivalent of the template gallery. Picking a pack opens a form built
 * from the pack's variable schema (from the registry's per-pack JSON API); the
 * filled values are written to the service's pack var-file (composeFile, HCL),
 * then a composeType="nomad-pack" service is created (the user hits Deploy).
 */
export const AddPack = ({
	environmentId,
	projectName,
	defaultOpen = false,
	initialPackName,
	initialRegistryUrl,
	hideTrigger = false,
	onCreated,
}: Props) => {
	const utils = api.useUtils();
	const slug = slugify(projectName);
	const [open, setOpen] = useState(defaultOpen);
	const [registry, setRegistry] = useState<string>(
		initialRegistryUrl && REGISTRIES.some((r) => r.url === initialRegistryUrl)
			? initialRegistryUrl
			: initialRegistryUrl
				? "__custom__"
				: REGISTRIES[0].url,
	);
	const [custom, setCustom] = useState(
		initialRegistryUrl && !REGISTRIES.some((r) => r.url === initialRegistryUrl)
			? initialRegistryUrl
			: "",
	);
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState<string>(ALL_CATEGORIES);
	const [selected, setSelected] = useState<PackSummary | null>(
		initialPackName
			? { name: initialPackName, description: "", version: "", url: "" }
			: null,
	);
	const [values, setValues] = useState<Record<string, string>>({});

	const registryUrl = registry === "__custom__" ? custom.trim() : registry;
	const { data: packs, isFetching } = api.nomad.listNomadPacks.useQuery(
		{ registryUrl: registryUrl || undefined },
		{ enabled: open && !!registryUrl },
	);
	const { data: detail, isFetching: detailLoading } =
		api.nomad.getNomadPack.useQuery(
			{ registryUrl: registryUrl || undefined, id: selected?.name ?? "" },
			{ enabled: open && !!selected?.name },
		);
	const create = api.compose.create.useMutation();

	// Seed the form with each variable's default once the schema loads.
	useEffect(() => {
		if (!detail?.variables) return;
		const seed: Record<string, string> = {};
		for (const v of detail.variables as PackVar[]) {
			if (isEditable(v)) seed[v.name] = displayDefault(v);
		}
		setValues(seed);
	}, [detail]);

	// Categories present in this registry (for the filter dropdown). The list is
	// already star-sorted server-side, so the order carries through.
	const categories = Array.from(
		new Set((packs ?? []).map((p) => p.category).filter(Boolean) as string[]),
	).sort((a, b) => a.localeCompare(b));

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
		setSelected(null);
		setValues({});
	};

	const deploy = async (composeFile?: string) => {
		if (!selected) return;
		const packName = selected.name;
		try {
			await create.mutateAsync({
				name: packName,
				environmentId,
				composeType: "nomad-pack",
				appName: `${slug}-${slugify(packName)}`,
				nomadPack: packName,
				// Blank registry = the community default (handled by the deploy builder).
				nomadPackRegistry: registryUrl === REGISTRIES[1].url ? "" : registryUrl,
				...(composeFile ? { composeFile } : {}),
			});
			toast.success(`Created "${packName}" — open it and hit Deploy`);
			setOpen(false);
			reset();
			await utils.environment.one.invalidate({ environmentId });
			await utils.project.all.invalidate();
			onCreated?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to create");
		}
	};

	const deployWithValues = async () => {
		const vars = ((detail?.variables as PackVar[]) ?? []).filter(isEditable);
		// Force placeholder (change-me) variables to actually be changed.
		for (const v of vars) {
			if (v.placeholder && (values[v.name] ?? "") === displayDefault(v)) {
				toast.error(`Please set a value for "${v.name}"`);
				return;
			}
			if (
				v.kind === "number" &&
				(values[v.name] ?? "").trim() !== "" &&
				Number.isNaN(Number(values[v.name]))
			) {
				toast.error(`"${v.name}" must be a number`);
				return;
			}
		}
		// Only write variables that differ from the default, plus sensitive /
		// placeholder ones — keeps the var-file minimal but always sets secrets.
		const lines: string[] = [];
		for (const v of vars) {
			const def = displayDefault(v);
			const cur = values[v.name] ?? def;
			if (cur === "" && v.kind !== "string") continue;
			if (cur !== def || v.sensitive || v.placeholder) {
				lines.push(`${v.name} = ${toHclLiteral(v, cur)}`);
			}
		}
		await deploy(lines.length ? `${lines.join("\n")}\n` : undefined);
	};

	const facts = detail?.facts as
		| {
				ports?: { name: string; port: string }[];
				tasks?: number;
				volumeNames?: string[];
				bundledDb?: boolean;
		  }
		| null
		| undefined;
	const editableVars = ((detail?.variables as PackVar[]) ?? []).filter(
		isEditable,
	);

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (!o) reset();
			}}
		>
			{!hideTrigger && (
				<DialogTrigger className="w-full">
					<DropdownMenuItem
						className="w-full cursor-pointer space-x-3"
						onSelect={(e) => e.preventDefault()}
					>
						<Box className="size-4 text-muted-foreground" />
						<span>Nomad Pack</span>
					</DropdownMenuItem>
				</DialogTrigger>
			)}
			<DialogContent className="p-0 sm:max-w-[70vw]">
				{selected ? (
					// ── Configure step ────────────────────────────────────────────────
					<>
						<DialogHeader className="border-b p-6">
							<div className="flex items-start gap-3">
								<div className="flex size-12 flex-none items-center justify-center rounded-md bg-muted/40">
									<PackLogo name={selected.name} icon={selected.icon} />
								</div>
								<div className="min-w-0 flex-1">
									<DialogTitle className="flex items-center gap-2">
										{detail?.name ?? selected.name}
										{detail?.version && (
											<Badge variant="blue" className="px-1.5 py-0 text-[10px]">
												{detail.version}
											</Badge>
										)}
									</DialogTitle>
									<DialogDescription className="line-clamp-2">
										{detail?.description ||
											selected.description ||
											"Configure and deploy this pack."}
									</DialogDescription>
									{facts && (
										<div className="mt-2 flex flex-wrap gap-1.5">
											{typeof facts.tasks === "number" && (
												<Badge variant="secondary" className="text-[10px]">
													{facts.tasks} task{facts.tasks === 1 ? "" : "s"}
												</Badge>
											)}
											{facts.bundledDb && (
												<Badge variant="secondary" className="text-[10px]">
													bundled DB
												</Badge>
											)}
											{(facts.ports ?? []).slice(0, 4).map((p) => (
												<Badge
													key={p.name}
													variant="secondary"
													className="text-[10px]"
												>
													{p.name}:{p.port}
												</Badge>
											))}
										</div>
									)}
								</div>
							</div>
						</DialogHeader>

						<ScrollArea className="h-[calc(80vh-11rem)]">
							<div className="space-y-4 p-6">
								{create.isError && (
									<AlertBlock type="error">{create.error?.message}</AlertBlock>
								)}
								{detailLoading ? (
									<div className="flex min-h-[30vh] items-center justify-center gap-3 text-muted-foreground">
										<Loader2 className="size-6 animate-spin" />
										<span className="text-sm">Loading configuration…</span>
									</div>
								) : editableVars.length === 0 ? (
									<AlertBlock type="info">
										This pack exposes no configurable variables here (or the
										registry has no variable schema). You can create it with its
										built-in defaults and edit variables afterwards.
									</AlertBlock>
								) : (
									editableVars.map((v) => (
										<div key={v.name} className="space-y-1.5">
											<Label className="flex items-center gap-2 text-sm">
												<code className="text-xs">{v.name}</code>
												{v.placeholder && (
													<Badge
														variant="yellow"
														className="px-1.5 py-0 text-[10px]"
													>
														change me
													</Badge>
												)}
												{v.sensitive && (
													<Badge
														variant="secondary"
														className="px-1.5 py-0 text-[10px]"
													>
														secret
													</Badge>
												)}
											</Label>
											{v.kind === "bool" ? (
												<Select
													value={values[v.name] ?? displayDefault(v)}
													onValueChange={(val) =>
														setValues((s) => ({ ...s, [v.name]: val }))
													}
												>
													<SelectTrigger className="w-full sm:w-[200px]">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="true">true</SelectItem>
														<SelectItem value="false">false</SelectItem>
													</SelectContent>
												</Select>
											) : (
												<Input
													type={
														v.sensitive
															? "password"
															: v.kind === "number"
																? "number"
																: "text"
													}
													value={values[v.name] ?? ""}
													onChange={(e) =>
														setValues((s) => ({
															...s,
															[v.name]: e.target.value,
														}))
													}
												/>
											)}
											{v.description && (
												<p className="text-muted-foreground text-xs">
													{v.description}
												</p>
											)}
										</div>
									))
								)}
							</div>
						</ScrollArea>

						<div className="flex items-center justify-between gap-3 border-t p-4">
							<Button
								variant="ghost"
								onClick={reset}
								disabled={create.isPending}
							>
								<ArrowLeft className="mr-2 size-4" />
								Back
							</Button>
							<div className="flex gap-2">
								{editableVars.length === 0 && (
									<Button
										variant="secondary"
										onClick={() => deploy()}
										disabled={create.isPending}
									>
										{create.isPending && (
											<Loader2 className="mr-2 size-4 animate-spin" />
										)}
										Create with defaults
									</Button>
								)}
								{editableVars.length > 0 && (
									<Button
										onClick={deployWithValues}
										disabled={create.isPending || detailLoading}
									>
										{create.isPending && (
											<Loader2 className="mr-2 size-4 animate-spin" />
										)}
										Create service
									</Button>
								)}
							</div>
						</div>
					</>
				) : (
					// ── Browse step ───────────────────────────────────────────────────
					<>
						<DialogHeader className="border-b p-6">
							<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
								<div>
									<DialogTitle>Deploy a Nomad Pack</DialogTitle>
									<DialogDescription>
										Browse a pack registry, configure it, and create a service.
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
											}}
										>
											<SelectTrigger className="w-full sm:w-[220px]">
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
												className="w-full sm:w-[240px]"
											/>
										</div>
									)}
									{categories.length > 0 && (
										<div className="space-y-1.5">
											<Label className="text-xs">Category</Label>
											<Select value={category} onValueChange={setCategory}>
												<SelectTrigger className="w-full sm:w-[180px]">
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
											className="w-full sm:w-[220px]"
										/>
									</div>
								</div>
							</div>
						</DialogHeader>

						<ScrollArea className="h-[calc(80vh-9rem)]">
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
										{filtered.map((p) => (
											<div
												key={p.name}
												className="flex flex-col gap-3 rounded-lg border p-4 transition-colors hover:border-primary/50"
											>
												<div className="flex items-start gap-3">
													<div className="flex size-12 flex-none items-center justify-center rounded-md bg-muted/40">
														<PackLogo name={p.name} icon={p.icon} />
													</div>
													<div className="min-w-0 flex-1">
														<div className="flex items-center gap-2">
															<span className="truncate font-medium text-sm">
																{p.name}
															</span>
															{p.version && (
																<Badge
																	variant="blue"
																	className="flex-none px-1.5 py-0 text-[10px]"
																>
																	{p.version}
																</Badge>
															)}
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
															{p.health?.ok === true && (
																<Badge
																	variant="outline"
																	className="gap-0.5 border-emerald-500/40 px-1.5 py-0 text-[10px] text-emerald-500"
																	title={
																		p.health.checkedAt
																			? `Boot-tested ${p.health.checkedAt}`
																			: "Boot-tested OK"
																	}
																>
																	<CheckCircle2 className="size-3" /> boots
																</Badge>
															)}
															{p.health?.ok === false && (
																<Badge
																	variant="outline"
																	className="gap-0.5 border-destructive/40 px-1.5 py-0 text-[10px] text-destructive"
																	title="Last boot test failed"
																>
																	<XCircle className="size-3" /> boot failed
																</Badge>
															)}
														</div>
														{p.url && (
															<a
																href={p.url}
																target="_blank"
																rel="noreferrer"
																className="mt-0.5 inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
															>
																Homepage <ExternalLink className="size-3" />
															</a>
														)}
													</div>
												</div>
												<p className="line-clamp-3 min-h-[3rem] text-muted-foreground text-xs">
													{p.description || "No description provided."}
												</p>
												<Button
													size="sm"
													variant="secondary"
													className="mt-auto"
													onClick={() => setSelected(p)}
												>
													Configure
												</Button>
											</div>
										))}
									</div>
								)}
							</div>
						</ScrollArea>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
};
