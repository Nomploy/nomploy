import { Box, ExternalLink, Loader2, SearchIcon } from "lucide-react";
import { useState } from "react";
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

const PackLogo = ({ name }: { name: string }) => {
	const [errored, setErrored] = useState(false);
	if (errored || !logoSlug(name)) {
		return <Box className="size-8 text-muted-foreground" />;
	}
	return (
		// biome-ignore lint/performance/noImgElement: external CDN logo, no next/image
		<img
			src={`https://cdn.simpleicons.org/${logoSlug(name)}`}
			alt={name}
			className="size-8 object-contain"
			onError={() => setErrored(true)}
		/>
	);
};

/**
 * Browse a Nomad Pack registry and one-click deploy a pack — the pack equivalent of
 * the template gallery. Creates a composeType="nomad-pack" service pointed at the
 * chosen pack + registry (then the user deploys it).
 */
export const AddPack = ({ environmentId, projectName }: Props) => {
	const utils = api.useUtils();
	const slug = slugify(projectName);
	const [open, setOpen] = useState(false);
	const [registry, setRegistry] = useState<string>(REGISTRIES[0].url);
	const [custom, setCustom] = useState("");
	const [search, setSearch] = useState("");
	const [pendingPack, setPendingPack] = useState<string | null>(null);

	const registryUrl = registry === "__custom__" ? custom.trim() : registry;
	const { data: packs, isFetching } = api.nomad.listNomadPacks.useQuery(
		{ registryUrl: registryUrl || undefined },
		{ enabled: open && !!registryUrl },
	);
	const create = api.compose.create.useMutation();

	const filtered = (packs ?? []).filter(
		(p) =>
			p.name.toLowerCase().includes(search.toLowerCase()) ||
			p.description.toLowerCase().includes(search.toLowerCase()),
	);

	const deploy = async (packName: string) => {
		setPendingPack(packName);
		try {
			await create.mutateAsync({
				name: packName,
				environmentId,
				composeType: "nomad-pack",
				appName: `${slug}-${slugify(packName)}`,
				nomadPack: packName,
				// Blank registry = the community default (handled by the deploy builder).
				nomadPackRegistry: registryUrl === REGISTRIES[1].url ? "" : registryUrl,
			});
			toast.success(`Created "${packName}" — open it and hit Deploy`);
			setOpen(false);
			await utils.environment.one.invalidate({ environmentId });
			await utils.project.all.invalidate();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to create");
		} finally {
			setPendingPack(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger className="w-full">
				<DropdownMenuItem
					className="w-full cursor-pointer space-x-3"
					onSelect={(e) => e.preventDefault()}
				>
					<Box className="size-4 text-muted-foreground" />
					<span>Nomad Pack</span>
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="p-0 sm:max-w-[70vw]">
				<DialogHeader className="border-b p-6">
					<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
						<div>
							<DialogTitle>Deploy a Nomad Pack</DialogTitle>
							<DialogDescription>
								Browse a pack registry and create a service from a pack.
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
						{create.isError && (
							<AlertBlock type="error" className="mb-4">
								{create.error?.message}
							</AlertBlock>
						)}

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
												<PackLogo name={p.name} />
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
											disabled={create.isPending}
											onClick={() => deploy(p.name)}
										>
											{pendingPack === p.name ? (
												<Loader2 className="mr-2 size-4 animate-spin" />
											) : null}
											Create
										</Button>
									</div>
								))}
							</div>
						)}
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);
};
