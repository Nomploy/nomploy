import { Box, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
	const [pack, setPack] = useState("");
	const [search, setSearch] = useState("");

	const registryUrl = registry === "__custom__" ? custom.trim() : registry;
	const { data: packs, isFetching } = api.nomad.listNomadPacks.useQuery(
		{ registryUrl: registryUrl || undefined },
		{ enabled: open && !!registryUrl },
	);
	const create = api.compose.create.useMutation();

	const filtered = (packs ?? []).filter((p) =>
		p.toLowerCase().includes(search.toLowerCase()),
	);

	const deploy = async () => {
		if (!pack) {
			toast.error("Pick a pack");
			return;
		}
		try {
			await create.mutateAsync({
				name: pack,
				environmentId,
				composeType: "nomad-pack",
				appName: `${slug}-${slugify(pack)}`,
				nomadPack: pack,
				// Blank registry = the community default (handled by the deploy builder).
				nomadPackRegistry: registryUrl === REGISTRIES[1].url ? "" : registryUrl,
			});
			toast.success(`Created "${pack}" — open it and hit Deploy`);
			setOpen(false);
			setPack("");
			await utils.environment.one.invalidate({ environmentId });
			await utils.project.all.invalidate();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to create");
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
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Deploy a Nomad Pack</DialogTitle>
					<DialogDescription>
						Browse a pack registry and create a service from a pack.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div className="space-y-1.5">
						<Label>Registry</Label>
						<Select
							value={registry}
							onValueChange={(v) => {
								setRegistry(v);
								setPack("");
							}}
						>
							<SelectTrigger>
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
						{registry === "__custom__" && (
							<Input
								placeholder="github.com/org/nomad-packs"
								value={custom}
								onChange={(e) => setCustom(e.target.value)}
							/>
						)}
					</div>

					<div className="space-y-1.5">
						<Label>Pack</Label>
						<Input
							placeholder="Search packs…"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
						<div className="max-h-[260px] overflow-y-auto rounded-md border">
							{isFetching ? (
								<div className="flex items-center gap-2 p-3 text-muted-foreground text-sm">
									<Loader2 className="h-4 w-4 animate-spin" /> Loading packs…
								</div>
							) : filtered.length === 0 ? (
								<p className="p-3 text-muted-foreground text-sm">
									No packs found.
								</p>
							) : (
								filtered.map((p) => (
									<button
										type="button"
										key={p}
										onClick={() => setPack(p)}
										className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted ${
											pack === p ? "bg-muted font-medium" : ""
										}`}
									>
										<Box className="size-4 text-muted-foreground" />
										{p}
									</button>
								))
							)}
						</div>
					</div>
				</div>

				{create.isError && (
					<AlertBlock type="error">{create.error?.message}</AlertBlock>
				)}

				<DialogFooter>
					<Button type="button" onClick={deploy} disabled={create.isPending}>
						{create.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : null}
						{pack ? `Create "${pack}"` : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
