import { Loader2, Save } from "lucide-react";
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
 * Node pool (autoscaling group) selector for a Nomad compose. Emits the job's
 * `node_pool` so the compose's services run in — and drive the scaling of — the
 * chosen group's pool. Redeploy to apply.
 */
export const ShowComposeNodePool = ({ composeId }: Props) => {
	const { data, refetch } = api.compose.one.useQuery(
		{ composeId },
		{ enabled: !!composeId },
	);
	const { data: groups } = api.nomad.listAutoscalingGroups.useQuery();
	const update = api.compose.update.useMutation();
	const [nodePool, setNodePool] = useState("default");

	useEffect(() => {
		if (data) setNodePool(data.nodePool || "default");
	}, [data]);

	const save = async () => {
		try {
			await update.mutateAsync({
				composeId,
				nodePool: nodePool === "default" ? null : nodePool,
			});
			toast.success("Node pool saved — redeploy to apply");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Node pool</CardTitle>
				<CardDescription>
					Which autoscaling group's node pool this compose's services run in.
					The group's scaling policy then reacts to their load. Redeploy to
					apply.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<div className="space-y-1.5 sm:max-w-xs">
					<Label>Autoscaling group</Label>
					<Select value={nodePool} onValueChange={setNodePool}>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="default">default</SelectItem>
							{groups
								?.filter((g) => !g.isDefault)
								.map((g) => (
									<SelectItem key={g.groupId} value={g.poolName}>
										{g.name} (pool: {g.poolName})
									</SelectItem>
								))}
						</SelectContent>
					</Select>
				</div>
				<div>
					<Button type="button" onClick={save} disabled={update.isPending}>
						{update.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Save className="mr-2 h-4 w-4" />
						)}
						{update.isPending ? "Saving…" : "Save"}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
