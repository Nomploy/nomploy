import { Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

/** Manage a self-hosted registry's retention + advanced zot config. */
export const SelfHostedSettings = ({ registryId }: { registryId: string }) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const { data } = api.registry.selfHostedConfig.useQuery(
		{ registryId },
		{ enabled: open },
	);
	const update = api.registry.updateSelfHostedConfig.useMutation();

	const [keepTags, setKeepTags] = useState(20);
	const [deleteUntagged, setDeleteUntagged] = useState(true);
	const [gcHours, setGcHours] = useState(24);
	const [override, setOverride] = useState("");

	useEffect(() => {
		if (!data) return;
		setKeepTags(data.retention?.keepTags ?? 20);
		setDeleteUntagged(data.retention?.deleteUntagged ?? true);
		setGcHours(data.retention?.gcIntervalHours ?? 24);
		setOverride(
			data.configOverride ? JSON.stringify(data.configOverride, null, 2) : "",
		);
	}, [data]);

	const save = async () => {
		let parsed: Record<string, unknown> | null = null;
		if (override.trim()) {
			try {
				parsed = JSON.parse(override);
				if (typeof parsed !== "object" || Array.isArray(parsed))
					throw new Error("not an object");
			} catch {
				toast.error("Config override must be a valid JSON object");
				return;
			}
		}
		try {
			await update.mutateAsync({
				registryId,
				retention: {
					keepTags,
					deleteUntagged,
					gcIntervalHours: gcHours,
				},
				configOverride: parsed,
			});
			await Promise.all([
				utils.registry.selfHostedConfig.invalidate({ registryId }),
				utils.registry.selfHostedStatus.invalidate({ registryId }),
			]);
			toast.success("Registry settings applied — zot is restarting");
			setOpen(false);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to apply settings");
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="ghost" size="icon" title="Registry settings">
					<Settings2 className="size-4 text-muted-foreground" />
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Registry settings</DialogTitle>
					<DialogDescription>
						Retention + advanced zot config. Saving re-applies the registry job
						(zot restarts with the new config; images in S3 are untouched).
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-5">
					<section className="flex flex-col gap-3">
						<span className="font-medium text-sm">Image retention</span>
						<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
							<div className="space-y-1">
								<Label className="text-xs">Keep last N tags / repo</Label>
								<Input
									type="number"
									min={1}
									value={keepTags}
									onChange={(e) => setKeepTags(Number(e.target.value) || 1)}
								/>
							</div>
							<div className="space-y-1">
								<Label className="text-xs">GC interval (hours)</Label>
								<Input
									type="number"
									min={1}
									value={gcHours}
									onChange={(e) => setGcHours(Number(e.target.value) || 1)}
								/>
							</div>
							<div className="flex items-center gap-2 pt-5">
								<Switch
									id="del-untagged"
									checked={deleteUntagged}
									onCheckedChange={setDeleteUntagged}
								/>
								<Label htmlFor="del-untagged" className="text-xs">
									Delete untagged
								</Label>
							</div>
						</div>
						<p className="text-muted-foreground text-xs">
							Older tags beyond the limit (and untagged manifests) are removed
							by the garbage collector, freeing S3 storage.
						</p>
					</section>

					<section className="flex flex-col gap-2">
						<span className="font-medium text-sm">
							Advanced config override (JSON)
						</span>
						<p className="text-muted-foreground text-xs">
							Deep-merged into the generated zot config. Storage credentials and
							auth are always enforced and can't be overridden here.
						</p>
						<Textarea
							className="min-h-[7rem] font-mono text-xs"
							placeholder={'{\n  "log": { "level": "debug" }\n}'}
							value={override}
							onChange={(e) => setOverride(e.target.value)}
						/>
					</section>

					{data?.rendered && (
						<section className="flex flex-col gap-2">
							<span className="font-medium text-sm">Effective config</span>
							<pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-snug">
								{data.rendered}
							</pre>
						</section>
					)}
				</div>

				<DialogFooter>
					<Button onClick={save} isLoading={update.isPending}>
						Apply
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
