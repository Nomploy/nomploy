import { Loader2, Scale } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/utils/api";

/**
 * Cluster-wide scheduler placement algorithm toggle.
 * - binpack: pack allocations onto the fewest nodes (default; best for
 *   autoscaling, since it frees whole nodes to scale down).
 * - spread: distribute allocations across nodes for resilience.
 */
export const ShowScheduler = ({ serverId }: { serverId?: string }) => {
	const { data, refetch, isLoading } = api.nomad.getSchedulerConfig.useQuery({
		serverId,
	});
	const setAlg = api.nomad.setSchedulerAlgorithm.useMutation();

	const current = data?.algorithm ?? "binpack";

	const apply = async (algorithm: "binpack" | "spread") => {
		if (algorithm === current) return;
		try {
			await setAlg.mutateAsync({ serverId, algorithm });
			toast.success(
				`Scheduler set to ${algorithm}. New placements use it; redeploy jobs to rebalance existing allocations.`,
			);
			await refetch();
		} catch (e) {
			toast.error(
				e instanceof Error ? e.message : "Failed to update scheduler",
			);
		}
	};

	return (
		<Card className="bg-sidebar rounded-xl">
			<CardHeader className="flex flex-row items-center justify-between">
				<CardTitle className="flex items-center gap-2 text-lg">
					<Scale className="h-5 w-5" />
					Scheduler placement
					{isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
				</CardTitle>
				<div className="flex items-center gap-1 rounded-lg border p-1">
					{(["binpack", "spread"] as const).map((alg) => (
						<Button
							key={alg}
							type="button"
							size="sm"
							variant={current === alg ? "default" : "ghost"}
							disabled={setAlg.isPending}
							onClick={() => apply(alg)}
						>
							{setAlg.isPending && setAlg.variables?.algorithm === alg && (
								<Loader2 className="mr-1 h-3 w-3 animate-spin" />
							)}
							{alg}
						</Button>
					))}
				</div>
			</CardHeader>
			<CardContent className="text-sm text-muted-foreground">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="secondary">current: {current}</Badge>
					{data?.memoryOversubscription && (
						<Badge variant="outline">memory oversubscription on</Badge>
					)}
				</div>
				<p className="mt-2">
					<strong>binpack</strong> packs allocations onto the fewest nodes —
					best with autoscaling, since it frees whole nodes to scale down.{" "}
					<strong>spread</strong> distributes allocations across nodes for
					resilience (a node failure affects fewer services), at the cost of
					harder scale-down. Changing it affects <em>new</em> placements;
					redeploy a job to rebalance its existing allocations.
				</p>
			</CardContent>
		</Card>
	);
};
