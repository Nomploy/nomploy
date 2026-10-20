import { CheckCircle2, Loader2, RotateCcw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

/**
 * Rollout panel for a job's latest Nomad deployment (application OR compose).
 * While running it shows per-group canary/health progress and offers Promote
 * (when a canary is healthy and awaiting it) + Cancel (fails → auto_revert). Once
 * finished it keeps a compact result line — successful / failed / reverted — so you
 * can see how the last deploy went instead of the panel just vanishing.
 * Reads/acts via the control plane (no serverId) — one cluster.
 * [[nomploy-nomad-reads-control-plane]]
 */
export const DeploymentPanel = ({ appName }: { appName: string }) => {
	const { data: dep, refetch } = api.nomad.getLatestDeployment.useQuery(
		{ jobId: appName },
		// Poll fast while a deploy is in flight; slower once it settles.
		{
			enabled: !!appName,
			refetchInterval: (q) =>
				q.state.data?.status === "running" ? 4000 : 20000,
		},
	);
	const promote = api.nomad.promoteDeployment.useMutation();
	const fail = api.nomad.failDeployment.useMutation();

	if (!dep) return null;
	const running = dep.status === "running";

	const doPromote = async () => {
		try {
			await promote.mutateAsync({ deploymentId: dep.id });
			toast.success("Deployment promoted");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Promote failed");
		}
	};
	const doFail = async () => {
		try {
			await fail.mutateAsync({ deploymentId: dep.id });
			toast.success("Deployment cancelled — reverting");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Cancel failed");
		}
	};

	// Terminal state → a compact one-card result line (no action buttons).
	if (!running) {
		const ok = dep.status === "successful";
		const reverted =
			dep.status === "cancelled" ||
			/revert/i.test(dep.description ?? "");
		const Icon = ok ? CheckCircle2 : reverted ? RotateCcw : XCircle;
		const tone = ok
			? "text-emerald-600"
			: reverted
				? "text-amber-600 dark:text-amber-500"
				: "text-destructive";
		const label = ok
			? "Last rollout successful"
			: reverted
				? "Last rollout reverted"
				: "Last rollout failed";
		return (
			<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3 text-sm">
				<span className={`flex items-center gap-1.5 font-medium ${tone}`}>
					<Icon className="size-4" />
					{label}
				</span>
				<span className="text-muted-foreground">{dep.description}</span>
				{dep.groups.map((g) => (
					<span key={g.name} className="text-xs text-muted-foreground">
						{g.name}: {g.healthyAllocs}/{g.desiredTotal} healthy
					</span>
				))}
			</div>
		);
	}

	return (
		<div className="mt-2 space-y-3 rounded-lg border p-4">
			<div className="flex items-center justify-between">
				<span className="flex items-center gap-2 font-medium">
					<Loader2 className="size-4 animate-spin text-primary" />
					Deployment in progress
				</span>
				<Badge variant={dep.awaitingPromotion ? "default" : "secondary"}>
					{dep.awaitingPromotion ? "awaiting promotion" : dep.status}
				</Badge>
			</div>
			<p className="text-muted-foreground text-sm">{dep.description}</p>
			{dep.blockedReason && (
				<AlertBlock type="error">
					{dep.blockedReason} The deploy is wedged — free up resources (or
					reduce this service's memory / turn off canary-with-volume so it
					doesn't need a second alloc), then Cancel and redeploy.
				</AlertBlock>
			)}
			<div className="space-y-1">
				{dep.groups.map((g) => {
					const total = g.desiredCanaries > 0 ? g.desiredCanaries : g.desiredTotal;
					const pct = total > 0 ? Math.min(100, (g.healthyAllocs / total) * 100) : 0;
					return (
						<div key={g.name} className="space-y-1">
							<div className="flex items-center gap-2 text-sm">
								<span className="font-mono">{g.name}</span>
								{g.desiredCanaries > 0 ? (
									<span className="text-muted-foreground">
										canary {g.placedCanaries}/{g.desiredCanaries} · healthy{" "}
										{g.healthyAllocs} · {g.promoted ? "promoted" : "pending"}
									</span>
								) : (
									<span className="text-muted-foreground">
										{g.healthyAllocs}/{g.desiredTotal} healthy
									</span>
								)}
							</div>
							<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
								<div
									className="h-full bg-primary transition-all"
									style={{ width: `${pct}%` }}
								/>
							</div>
						</div>
					);
				})}
			</div>
			{dep.awaitingPromotion && (
				<AlertBlock type="info">
					Canaries are healthy and waiting for promotion. The new version runs
					beside the old one — Promote to cut over, or Cancel to revert.
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
