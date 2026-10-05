import { ArrowUpCircle, Box, Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/shared/code-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

interface Props {
	composeId: string;
}

/**
 * Settings for a "Nomad Pack" service: the pack to deploy, an optional custom
 * registry, and the pack variables (HCL, stored in composeFile). Deploy runs
 * `nomad-pack run` (see getBuildNomadPackCommand).
 */
export const ShowNomadPackForm = ({ composeId }: Props) => {
	const { data, refetch } = api.compose.one.useQuery({ composeId });
	const update = api.compose.update.useMutation();
	// Pinned pack version vs the registry's latest, + the upgrade preview/apply.
	const { data: version, refetch: refetchVersion } =
		api.compose.getPackVersion.useQuery(
			{ composeId },
			{ enabled: !!composeId, refetchInterval: 60000 },
		);
	const preview = api.compose.previewPackUpgrade.useMutation();
	const upgrade = api.compose.upgradePack.useMutation();
	const [upgradeOpen, setUpgradeOpen] = useState(false);

	const openUpgrade = async () => {
		setUpgradeOpen(true);
		await preview
			.mutateAsync({ composeId })
			.catch((e) =>
				toast.error(e instanceof Error ? e.message : "Failed to render diff"),
			);
	};
	const applyUpgrade = async () => {
		try {
			const r = await upgrade.mutateAsync({ composeId });
			toast.success(`Upgrading pack to ${r.ref.slice(0, 7)} — redeploying`);
			setUpgradeOpen(false);
			await Promise.all([refetch(), refetchVersion()]);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Upgrade failed");
		}
	};

	const [nomadPack, setNomadPack] = useState("");
	const [nomadPackRegistry, setNomadPackRegistry] = useState("");
	const [nomadPackRef, setNomadPackRef] = useState("");
	const [variables, setVariables] = useState("");
	const [browse, setBrowse] = useState(false);
	// Enumerate packs in the registry only on demand (it adds the registry + reads
	// the cache — a few seconds). Uses the custom registry if set, else community.
	const { data: packs, isFetching: packsLoading } =
		api.nomad.listNomadPacks.useQuery(
			{
				serverId: data?.serverId || undefined,
				registryUrl: nomadPackRegistry.trim() || undefined,
			},
			{ enabled: browse },
		);

	useEffect(() => {
		if (!data) return;
		setNomadPack(data.nomadPack ?? "");
		setNomadPackRegistry(data.nomadPackRegistry ?? "");
		setNomadPackRef(data.nomadPackRef ?? "");
		setVariables(data.composeFile ?? "");
	}, [data]);

	const save = async () => {
		if (!nomadPack.trim()) {
			toast.error("Enter a pack to deploy");
			return;
		}
		try {
			await update.mutateAsync({
				composeId,
				nomadPack: nomadPack.trim(),
				nomadPackRegistry: nomadPackRegistry.trim(),
				nomadPackRef: nomadPackRef.trim(),
				composeFile: variables,
			});
			toast.success("Pack settings saved");
			await Promise.all([refetch(), refetchVersion()]);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	// Compare against the last-saved values so a failed/half save stays flagged
	// (the control-plane session can 401 mid-edit and silently drop a save).
	const dirty =
		!!data &&
		(nomadPack !== (data.nomadPack ?? "") ||
			nomadPackRegistry !== (data.nomadPackRegistry ?? "") ||
			nomadPackRef !== (data.nomadPackRef ?? "") ||
			variables !== (data.composeFile ?? ""));

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Box className="size-5" />
					Nomad Pack
				</CardTitle>
				<CardDescription>
					Deploy a{" "}
					<a
						href="https://github.com/hashicorp/nomad-pack-community-registry"
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-2"
					>
						Nomad Pack
					</a>{" "}
					by name from the community registry (or a custom git registry), with
					your variables. Deploy runs{" "}
					<code className="rounded bg-muted px-1">nomad-pack run</code>.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{version?.isPack && version.pinnedRef && (
					<div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
						<div className="flex flex-col gap-0.5">
							<span className="text-sm">
								Pinned version{" "}
								<code className="rounded bg-muted px-1 font-mono text-xs">
									{version.pinnedRef.slice(0, 7)}
								</code>
								{version.upgradeAvailable && version.latestRef && (
									<>
										{" → "}
										<code className="rounded bg-muted px-1 font-mono text-xs">
											{version.latestRef.slice(0, 7)}
										</code>
									</>
								)}
							</span>
							<span className="text-muted-foreground text-xs">
								Deploys use this exact ref (reproducible). Upgrade to pull the
								registry's latest.
							</span>
						</div>
						<div className="flex items-center gap-2">
							{version.upgradeAvailable ? (
								<>
									<Badge
										variant="outline"
										className="border-amber-500/40 text-amber-600 dark:text-amber-400"
									>
										Upgrade available
									</Badge>
									<Button size="sm" variant="outline" onClick={openUpgrade}>
										<ArrowUpCircle className="mr-2 h-4 w-4" /> Upgrade
									</Button>
								</>
							) : (
								<Badge
									variant="outline"
									className="border-emerald-500/40 text-emerald-500"
								>
									Up to date
								</Badge>
							)}
						</div>
					</div>
				)}
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label>Pack</Label>
						<Input
							placeholder="e.g. traefik or hello_world"
							value={nomadPack}
							onChange={(e) => setNomadPack(e.target.value)}
						/>
						{browse ? (
							<Select value={nomadPack} onValueChange={setNomadPack}>
								<SelectTrigger>
									<SelectValue
										placeholder={
											packsLoading ? "Loading packs…" : "Pick a pack"
										}
									/>
								</SelectTrigger>
								<SelectContent>
									{(packs ?? []).map((p) => (
										<SelectItem key={p.name} value={p.name}>
											{p.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : (
							<button
								type="button"
								className="text-muted-foreground text-xs underline underline-offset-2"
								onClick={() => setBrowse(true)}
							>
								Browse packs from registry
							</button>
						)}
						{browse && !packsLoading && (packs ?? []).length === 0 && (
							<p className="text-muted-foreground text-xs">
								No packs found (is nomad-pack available + the registry
								reachable?).
							</p>
						)}
					</div>
					<div className="space-y-1.5">
						<Label>Custom registry (optional)</Label>
						<Input
							placeholder="git URL — blank uses the community registry"
							value={nomadPackRegistry}
							onChange={(e) => setNomadPackRegistry(e.target.value)}
						/>
					</div>
				</div>
				<div className="space-y-1.5">
					<Label>Registry ref (pin)</Label>
					<Input
						placeholder="commit / tag / branch — blank auto-pins on first deploy"
						value={nomadPackRef}
						onChange={(e) => setNomadPackRef(e.target.value)}
						className="font-mono text-xs"
					/>
					<p className="text-muted-foreground text-xs">
						Which registry version to render. A commit or tag{" "}
						<strong>pins</strong> it (reproducible); a branch like{" "}
						<code>master</code> <strong>tracks the latest</strong> each deploy,
						so a registry change applies on the next redeploy; blank re-pins to
						the current latest on the next deploy. The Upgrade button above sets
						this to the registry's latest commit.
					</p>
				</div>
				<div className="space-y-1.5">
					<div className="flex items-center justify-between">
						<Label>Variables (HCL)</Label>
						{dirty && (
							<Badge
								variant="outline"
								className="border-amber-500/40 text-amber-600 dark:text-amber-400"
							>
								Unsaved changes
							</Badge>
						)}
					</div>
					<div
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
								e.preventDefault();
								if (!update.isPending) save();
							}
						}}
					>
						<CodeEditor
							language="properties"
							lineWrapping
							wrapperClassName="max-h-[55vh] rounded-md border"
							placeholder={
								'# pack variables, e.g.\ncount = 2\nregion = "global"'
							}
							value={variables}
							onChange={(value) => setVariables(value)}
						/>
					</div>
					<p className="text-muted-foreground text-xs">
						Passed as <code>--var-file</code>. Leave empty to use the pack's
						defaults. Save (⌘/Ctrl+S), then Deploy to run the pack.
					</p>
				</div>
				<div>
					<Button
						type="button"
						onClick={save}
						disabled={update.isPending || !dirty}
					>
						{update.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Save className="mr-2 h-4 w-4" />
						)}
						{update.isPending ? "Saving…" : dirty ? "Save" : "Saved"}
					</Button>
				</div>
			</CardContent>

			<Dialog open={upgradeOpen} onOpenChange={setUpgradeOpen}>
				<DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden">
					<DialogHeader>
						<DialogTitle>Upgrade pack</DialogTitle>
						<DialogDescription>
							{preview.data?.fromRef && preview.data?.toRef ? (
								<>
									Changes to the rendered Nomad job from{" "}
									<code className="font-mono">
										{preview.data.fromRef.slice(0, 7)}
									</code>{" "}
									to{" "}
									<code className="font-mono">
										{preview.data.toRef.slice(0, 7)}
									</code>
									. Review before applying — Apply pins the new ref and
									redeploys.
								</>
							) : (
								"Rendering the diff between the pinned version and the registry's latest…"
							)}
						</DialogDescription>
					</DialogHeader>
					<div className="max-h-[55vh] overflow-auto rounded-md border bg-muted/40">
						{preview.isPending ? (
							<div className="flex items-center gap-2 p-4 text-muted-foreground text-sm">
								<Loader2 className="h-4 w-4 animate-spin" /> Rendering diff…
							</div>
						) : preview.data?.diff ? (
							<pre className="whitespace-pre p-3 font-mono text-xs leading-relaxed">
								{preview.data.diff}
							</pre>
						) : (
							<p className="p-4 text-muted-foreground text-sm">
								No differences in the rendered job between the two versions.
							</p>
						)}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setUpgradeOpen(false)}>
							Cancel
						</Button>
						<Button
							onClick={applyUpgrade}
							disabled={upgrade.isPending || preview.isPending}
						>
							{upgrade.isPending ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<ArrowUpCircle className="mr-2 h-4 w-4" />
							)}
							{upgrade.isPending ? "Upgrading…" : "Apply & redeploy"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
};
