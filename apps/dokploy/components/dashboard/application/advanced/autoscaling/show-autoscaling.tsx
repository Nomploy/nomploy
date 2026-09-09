import { Activity, Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
}

/**
 * Horizontal autoscaling policy for an application's Nomad job. When enabled, the
 * job gets a scaling{} block the Nomad Autoscaler drives toward the CPU/memory
 * targets, between min and max replicas. Redeploy to apply changes.
 */
export const ShowApplicationAutoscaling = ({ applicationId }: Props) => {
	const { data, refetch } = api.application.one.useQuery({ applicationId });
	const update = api.application.update.useMutation();

	const [enabled, setEnabled] = useState(false);
	const [min, setMin] = useState(1);
	const [max, setMax] = useState(3);
	const [cpu, setCpu] = useState<string>("");
	const [mem, setMem] = useState<string>("");

	useEffect(() => {
		if (!data) return;
		setEnabled(!!data.autoscalingEnabled);
		setMin(data.minReplicas ?? 1);
		setMax(data.maxReplicas ?? 3);
		setCpu(
			data.autoscaleCpuTarget != null ? String(data.autoscaleCpuTarget) : "",
		);
		setMem(
			data.autoscaleMemoryTarget != null
				? String(data.autoscaleMemoryTarget)
				: "",
		);
	}, [data]);

	const save = async () => {
		if (enabled && !cpu && !mem) {
			toast.error("Set a CPU or memory target for autoscaling");
			return;
		}
		if (enabled && max < min) {
			toast.error("Max replicas must be ≥ min");
			return;
		}
		try {
			await update.mutateAsync({
				applicationId,
				autoscalingEnabled: enabled,
				minReplicas: min,
				maxReplicas: max,
				autoscaleCpuTarget: cpu ? Number(cpu) : null,
				autoscaleMemoryTarget: mem ? Number(mem) : null,
			});
			toast.success("Autoscaling saved — redeploy to apply");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1.5">
					<CardTitle className="flex items-center gap-2 text-xl">
						<Activity className="size-5" />
						Autoscaling
					</CardTitle>
					<CardDescription>
						Let the Nomad Autoscaler scale this app's replicas automatically
						between min and max, steering toward CPU/memory targets. Redeploy to
						apply. When off, the fixed replica count is used.
					</CardDescription>
				</div>
				<Switch checked={enabled} onCheckedChange={setEnabled} />
			</CardHeader>
			{enabled && (
				<CardContent className="flex flex-col gap-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label>Min replicas</Label>
							<Input
								type="number"
								min={1}
								value={min}
								onChange={(e) =>
									setMin(Math.max(1, Number(e.target.value) || 1))
								}
							/>
							<p className="text-muted-foreground text-xs">
								At least 1 — the autoscaler steers on live utilization, so it
								can't scale an app back up from zero.
							</p>
						</div>
						<div className="space-y-1.5">
							<Label>Max replicas</Label>
							<Input
								type="number"
								min={1}
								value={max}
								onChange={(e) => setMax(Number(e.target.value) || 1)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label>CPU target % (optional)</Label>
							<Input
								type="number"
								placeholder="e.g. 70"
								value={cpu}
								onChange={(e) => setCpu(e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label>Memory target % (optional)</Label>
							<Input
								type="number"
								placeholder="e.g. 80"
								value={mem}
								onChange={(e) => setMem(e.target.value)}
							/>
						</div>
					</div>
				</CardContent>
			)}
			<CardContent>
				<Button type="button" onClick={save} disabled={update.isPending}>
					{update.isPending ? (
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
					) : (
						<Save className="mr-2 h-4 w-4" />
					)}
					{update.isPending ? "Saving…" : "Save"}
				</Button>
			</CardContent>
		</Card>
	);
};
