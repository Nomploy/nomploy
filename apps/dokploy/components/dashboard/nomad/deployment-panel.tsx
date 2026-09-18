import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

/**
 * Live panel for an in-flight Nomad deployment of a job (application OR compose).
 * Polls the job's latest deployment; while it's running it shows per-group
 * progress and offers:
 *   - Promote — enabled only when a canary is healthy and awaiting promotion.
 *   - Cancel  — always available for a running deployment (fails it → auto_revert
 *               to the last healthy version). This is the escape hatch for a
 *               deployment wedged unhealthy that the service page otherwise can't
 *               clear.
 * Reads/acts via the control plane (no serverId) — one cluster.
 * [[nomploy-nomad-reads-control-plane]]
 */
export const DeploymentPanel = ({ appName }: { appName: string }) => {
	const { data: dep, refetch } = api.nomad.getLatestDeployment.useQuery(
		{ jobId: appName },
		{ enabled: !!appName, refetchInterval: 5000 },
	);
	const promote = api.nomad.promoteDeployment.useMutation();
	const fail = api.nomad.failDeployment.useMutation();

	if (!dep || dep.status !== "running") return null;

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

	return (
		<div className="mt-2 space-y-3 rounded-lg border p-4">
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
