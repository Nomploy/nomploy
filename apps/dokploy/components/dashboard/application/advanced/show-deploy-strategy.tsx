import { Loader2, Rocket, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DeploymentPanel } from "@/components/dashboard/nomad/deployment-panel";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
	appName?: string;
	serverId?: string;
}

/**
 * Deployment strategy for an application's Nomad job.
 * - Rolling (default): replace allocations gradually, one (max_parallel) at a
 *   time, with auto-revert on failure.
 * - Canary: run N canary allocations beside the running version until they're
 *   healthy, then promote — automatically, or manually (health-gated). The
 *   promotion panel below appears live while a canary deploy is in flight.
 */
export const ShowDeployStrategy = ({ applicationId, appName }: Props) => {
	const { data, refetch } = api.application.one.useQuery({ applicationId });
	const save = api.application.saveDeployStrategy.useMutation();

	const [mode, setMode] = useState<"rolling" | "canary">("rolling");
	const [maxParallel, setMaxParallel] = useState(1);
	const [canaryCount, setCanaryCount] = useState(1);
	const [autoPromote, setAutoPromote] = useState(false);
	const [allowCanaryWithVolume, setAllowCanaryWithVolume] = useState(false);

	useEffect(() => {
		if (!data) return;
		const canary = data.canaryCount ?? 0;
		setMode(canary > 0 ? "canary" : "rolling");
		setMaxParallel(data.updateMaxParallel ?? 1);
		setCanaryCount(canary > 0 ? canary : (data.replicas ?? 1));
		setAutoPromote(!!data.autoPromote);
		setAllowCanaryWithVolume(!!data.allowCanaryWithVolume);
	}, [data]);

	const onSave = async () => {
		try {
			await save.mutateAsync({
				applicationId,
				updateMaxParallel: Math.max(1, maxParallel),
				canaryCount: mode === "canary" ? Math.max(1, canaryCount) : 0,
				autoPromote,
				allowCanaryWithVolume,
			});
			toast.success("Deployment strategy saved — redeploy to apply");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Rocket className="size-5" />
					Deployment Strategy
				</CardTitle>
				<CardDescription>
					How new versions of this app roll out. Rolling replaces allocations
					gradually; canary runs new allocations alongside the old ones and
					promotes once healthy. Applied on the next redeploy.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label>Strategy</Label>
						<Select
							value={mode}
							onValueChange={(v) => setMode(v as "rolling" | "canary")}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="rolling">Rolling</SelectItem>
								<SelectItem value="canary">Canary</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<Label>Max parallel</Label>
						<Input
							type="number"
							min={1}
							value={maxParallel}
							onChange={(e) => setMaxParallel(Number(e.target.value) || 1)}
						/>
						<p className="text-muted-foreground text-xs">
							How many allocations Nomad updates at once.
						</p>
					</div>
					{mode === "canary" && (
						<>
							<div className="space-y-1.5">
								<Label>Canary count</Label>
								<Input
									type="number"
									min={1}
									value={canaryCount}
									onChange={(e) => setCanaryCount(Number(e.target.value) || 1)}
								/>
								<p className="text-muted-foreground text-xs">
									New allocations to run beside the old version. Set equal to
									the replica count for a full blue/green rollout.
								</p>
							</div>
							<div className="flex items-center justify-between rounded-lg border p-3">
								<div className="space-y-0.5">
									<Label>Auto-promote</Label>
									<p className="text-muted-foreground text-xs">
										Promote automatically once canaries are healthy. Off = wait
										for a manual promote below.
									</p>
								</div>
								<Switch
									checked={autoPromote}
									onCheckedChange={setAutoPromote}
								/>
							</div>
							<div className="flex items-center justify-between rounded-lg border p-3 sm:col-span-2">
								<div className="space-y-0.5">
									<Label>Allow canary with a writable volume</Label>
									<p className="text-muted-foreground text-xs">
										By default a writable volume forces a plain restart (a
										canary would run a 2nd copy sharing the same exclusive
										volume). Enable only if the app tolerates brief concurrent
										access to it.
									</p>
								</div>
								<Switch
									checked={allowCanaryWithVolume}
									onCheckedChange={setAllowCanaryWithVolume}
								/>
							</div>
						</>
					)}
				</div>
				<div>
					<Button type="button" onClick={onSave} disabled={save.isPending}>
						{save.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Save className="mr-2 h-4 w-4" />
						)}
						{save.isPending ? "Saving…" : "Save"}
					</Button>
				</div>

				{appName && <DeploymentPanel appName={appName} />}
			</CardContent>
		</Card>
	);
};
