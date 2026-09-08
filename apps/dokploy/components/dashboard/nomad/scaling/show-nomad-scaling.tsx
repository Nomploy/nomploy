import { Activity, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { api } from "@/utils/api";

interface Props {
	appName: string;
	serverId?: string;
}

interface TaskGroupSpec {
	Name: string;
	Count: number;
	Scaling?: { Min?: number; Max?: number; Enabled?: boolean } | null;
}

/**
 * Per-service scaling: shows each task group's live count, its autoscaling policy
 * (min/max + whether the Nomad Autoscaler is driving it, from the job's
 * scaling{} block) and a manual "scale to N" control.
 */
export const ShowNomadScaling = ({ appName, serverId }: Props) => {
	const { data: job } = api.nomad.getJob.useQuery(
		{ jobId: appName, serverId },
		{ enabled: !!appName },
	);
	const { data: scale, refetch } = api.nomad.getJobScale.useQuery(
		{ jobId: appName, serverId },
		{ enabled: !!appName, refetchInterval: 10000 },
	);
	const scaleMut = api.nomad.scaleNomadJob.useMutation();

	// biome-ignore lint/suspicious/noExplicitAny: Nomad job/scale API shapes
	const groups: TaskGroupSpec[] = (job as any)?.TaskGroups ?? [];
	// biome-ignore lint/suspicious/noExplicitAny: Nomad scale-status shape
	const statusByGroup: Record<string, any> = (scale as any)?.TaskGroups ?? {};

	const [counts, setCounts] = useState<Record<string, number>>({});
	useEffect(() => {
		// Seed the inputs with each group's current desired count.
		const seed: Record<string, number> = {};
		for (const g of groups) {
			seed[g.Name] = statusByGroup[g.Name]?.Desired ?? g.Count ?? 1;
		}
		setCounts((c) => ({ ...seed, ...c }));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [job, scale]);

	const doScale = async (group: string) => {
		try {
			await scaleMut.mutateAsync({
				jobId: appName,
				group,
				count: counts[group] ?? 1,
				serverId,
			});
			toast.success(`Scaled ${group} to ${counts[group]}`);
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Scale failed");
		}
	};

	if (groups.length === 0) return null;

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Activity className="size-5" />
					Scaling
				</CardTitle>
				<CardDescription>
					Live replica counts per task group. An <code>x-nomad-scaling</code>{" "}
					policy (min/max + CPU/memory target) lets the Nomad Autoscaler adjust
					the count automatically; you can also scale manually here.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{groups.map((g) => {
					const st = statusByGroup[g.Name] ?? {};
					const running = st.Running ?? 0;
					const desired = st.Desired ?? g.Count ?? 0;
					const auto = !!g.Scaling?.Enabled;
					return (
						<div
							key={g.Name}
							className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
						>
							<div className="flex flex-col gap-0.5">
								<div className="flex items-center gap-2">
									<span className="font-medium">{g.Name}</span>
									{auto ? (
										<Badge className="bg-emerald-500 text-white hover:bg-emerald-500">
											autoscaling
										</Badge>
									) : (
										<Badge variant="outline">manual</Badge>
									)}
								</div>
								<span className="text-muted-foreground text-xs">
									{running}/{desired} running
									{g.Scaling
										? ` · policy ${g.Scaling.Min ?? 0}–${g.Scaling.Max ?? "∞"}`
										: ""}
								</span>
							</div>
							<div className="flex items-center gap-2">
								<Input
									type="number"
									min={g.Scaling?.Min ?? 0}
									max={g.Scaling?.Max ?? undefined}
									className="w-20"
									value={counts[g.Name] ?? desired}
									onChange={(e) =>
										setCounts((c) => ({
											...c,
											[g.Name]: Number(e.target.value) || 0,
										}))
									}
								/>
								<Button
									type="button"
									size="sm"
									onClick={() => doScale(g.Name)}
									disabled={scaleMut.isPending}
								>
									{scaleMut.isPending ? (
										<Loader2 className="h-4 w-4 animate-spin" />
									) : (
										"Scale"
									)}
								</Button>
							</div>
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
};
