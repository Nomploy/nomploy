import { CheckCircle2, Loader2, Rocket, Save, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
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
export const ShowDeployStrategy = ({
	applicationId,
	appName,
	serverId,
}: Props) => {
	const { data, refetch } = api.application.one.useQuery({ applicationId });
	const save = api.application.saveDeployStrategy.useMutation();

	const [mode, setMode] = useState<"rolling" | "canary">("rolling");
	const [maxParallel, setMaxParallel] = useState(1);
	const [canaryCount, setCanaryCount] = useState(1);
	const [autoPromote, setAutoPromote] = useState(false);

	useEffect(() => {
		if (!data) return;
		const canary = data.canaryCount ?? 0;
		setMode(canary > 0 ? "canary" : "rolling");
		setMaxParallel(data.updateMaxParallel ?? 1);
		setCanaryCount(canary > 0 ? canary : (data.replicas ?? 1));
		setAutoPromote(!!data.autoPromote);
	}, [data]);

	const onSave = async () => {
		try {
			await save.mutateAsync({
				applicationId,
				updateMaxParallel: Math.max(1, maxParallel),
				canaryCount: mode === "canary" ? Math.max(1, canaryCount) : 0,
				autoPromote,
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

				{appName && <CanaryPromotion appName={appName} serverId={serverId} />}
			</CardContent>
		</Card>
	);
};

// Live panel for an in-flight deployment. Polls the job's latest Nomad
// deployment and, when canaries are healthy but not yet promoted, offers a
// manual Promote / Cancel (health-gated rollout).
const CanaryPromotion = ({
	appName,
	serverId,
}: {
	appName: string;
	serverId?: string;
}) => {
	const { data: dep, refetch } = api.nomad.getLatestDeployment.useQuery(
		{ jobId: appName, serverId },
		{ enabled: !!appName, refetchInterval: 5000 },
	);
	const promote = api.nomad.promoteDeployment.useMutation();
	const fail = api.nomad.failDeployment.useMutation();

	if (!dep || dep.status !== "running") return null;

	const doPromote = async () => {
		try {
			await promote.mutateAsync({ deploymentId: dep.id, serverId });
			toast.success("Deployment promoted");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Promote failed");
		}
	};
	const doFail = async () => {
		try {
			await fail.mutateAsync({ deploymentId: dep.id, serverId });
			toast.success("Deployment cancelled — reverting");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Cancel failed");
		}
	};

	return (
		<div className="mt-2 rounded-lg border p-4 space-y-3">
			<div className="flex items-center justify-between">
				<span className="font-medium">Deployment in progress</span>
				<Badge variant={dep.awaitingPromotion ? "default" : "secondary"}>
					{dep.awaitingPromotion ? "awaiting promotion" : dep.status}
				</Badge>
			</div>
			<p className="text-muted-foreground text-sm">{dep.description}</p>
			<div className="space-y-1">
				{dep.groups.map((g) => (
					<div key={g.name} className="flex items-center gap-2 text-sm">
						<span className="font-mono">{g.name}</span>
						{g.desiredCanaries > 0 ? (
							<span className="text-muted-foreground">
								canaries {g.placedCanaries}/{g.desiredCanaries} · healthy{" "}
								{g.healthyAllocs} · {g.promoted ? "promoted" : "pending"}
							</span>
						) : (
							<span className="text-muted-foreground">
								{g.healthyAllocs}/{g.desiredTotal} healthy
							</span>
						)}
					</div>
				))}
			</div>
			{dep.awaitingPromotion && (
				<AlertBlock type="info">
					Canaries are healthy and waiting for promotion.
				</AlertBlock>
			)}
			<div className="flex gap-2">
				<Button
					type="button"
					size="sm"
					onClick={doPromote}
					disabled={!dep.awaitingPromotion || promote.isPending}
				>
					{promote.isPending ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<CheckCircle2 className="mr-2 h-4 w-4" />
					)}
					Promote
				</Button>
				<Button
					type="button"
					size="sm"
					variant="destructive"
					onClick={doFail}
					disabled={fail.isPending}
				>
					{fail.isPending ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<XCircle className="mr-2 h-4 w-4" />
					)}
					Cancel
				</Button>
			</div>
		</div>
	);
};
