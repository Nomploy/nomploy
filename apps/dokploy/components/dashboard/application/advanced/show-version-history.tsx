import { History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

interface Props {
	appName?: string;
	serverId?: string;
}

/**
 * Nomad keeps every submitted version of a job. This lists them (newest first)
 * and offers an instant one-click revert to any prior version — Nomad re-submits
 * that version's full spec (image + env + resources) as a new deployment, with
 * no rebuild. Complements the image-based rollback with a true "undo this deploy".
 */
export const ShowVersionHistory = ({ appName, serverId }: Props) => {
	const {
		data: versions,
		isLoading,
		refetch,
	} = api.nomad.getJobVersions.useQuery(
		{ jobId: appName || "", serverId },
		{ enabled: !!appName, refetchInterval: 15000 },
	);
	const revert = api.nomad.revertJob.useMutation();

	const doRevert = async (version: number) => {
		if (!appName) return;
		try {
			await revert.mutateAsync({ jobId: appName, version, serverId });
			toast.success(`Reverting to version ${version}…`);
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Revert failed");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<History className="size-5" />
					Version History
				</CardTitle>
				<CardDescription>
					Every deployed version of this app's Nomad job. Revert to a previous
					one to instantly restore its spec (image, env, resources) — no
					rebuild.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{isLoading && (
					<div className="flex items-center justify-center p-6">
						<Loader2 className="h-5 w-5 animate-spin" />
					</div>
				)}
				{!isLoading && (!versions || versions.length === 0) && (
					<p className="text-sm text-muted-foreground">
						No version history yet — deploy the app first.
					</p>
				)}
				<div className="flex flex-col divide-y">
					{versions?.map((v) => (
						<div
							key={v.version}
							className="flex items-center justify-between gap-3 py-2.5"
						>
							<div className="flex items-center gap-2 min-w-0">
								<span className="font-mono text-sm">v{v.version}</span>
								{v.current && <Badge>current</Badge>}
								{v.stable && !v.current && (
									<Badge variant="secondary">stable</Badge>
								)}
								{v.image && (
									<span
										className="truncate text-xs text-muted-foreground max-w-[280px]"
										title={v.image}
									>
										{v.image}
									</span>
								)}
							</div>
							<div className="flex items-center gap-3 shrink-0">
								<span className="text-xs text-muted-foreground">
									{v.submitTime ? new Date(v.submitTime).toLocaleString() : ""}
								</span>
								{!v.current && (
									<DialogAction
										title={`Revert to version ${v.version}?`}
										description="Nomad will re-submit this version's spec as a new deployment. Health checks and auto-revert still apply."
										type="default"
										onClick={() => doRevert(v.version)}
									>
										<Button
											variant="outline"
											size="sm"
											disabled={revert.isPending}
										>
											<RotateCcw className="mr-2 h-3.5 w-3.5" />
											Revert
										</Button>
									</DialogAction>
								)}
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
};
