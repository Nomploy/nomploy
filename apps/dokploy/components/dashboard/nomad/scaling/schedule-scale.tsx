import { Clock, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
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
 * Scheduled scaling for a compose: create cron schedules that scale a task group to
 * a fixed count (e.g. down at night, up in the morning). Backed by scheduleType
 * "nomad-scale" — the runner calls the Nomad scale API on the cron. Kept as its own
 * small form; the generic schedule form is command-only.
 */
export const ScheduleScale = ({ composeId }: Props) => {
	const utils = api.useUtils();
	const { data: services } = api.compose.loadServices.useQuery(
		{ composeId, type: "cache" },
		{ enabled: !!composeId },
	);
	const { data: schedules } = api.schedule.list.useQuery(
		{ id: composeId, scheduleType: "compose" },
		{ enabled: !!composeId },
	);
	const create = api.schedule.create.useMutation();
	const remove = api.schedule.delete.useMutation();

	const [name, setName] = useState("");
	const [group, setGroup] = useState("");
	const [count, setCount] = useState(1);
	const [cron, setCron] = useState("0 22 * * *");

	const scaleSchedules = (schedules ?? []).filter(
		(s) => s.scheduleType === "nomad-scale",
	);

	const refresh = () =>
		utils.schedule.list.invalidate({ id: composeId, scheduleType: "compose" });

	const add = async () => {
		if (!group || !name || !cron) {
			toast.error("Name, group and cron are required");
			return;
		}
		try {
			await create.mutateAsync({
				name,
				cronExpression: cron,
				scheduleType: "nomad-scale",
				composeId,
				serviceName: group,
				scaleCount: count,
				command: `scale ${group} to ${count}`,
				shellType: "bash",
				enabled: true,
				script: "",
			});
			toast.success("Scheduled scale created");
			setName("");
			await refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to create");
		}
	};

	const del = async (scheduleId: string) => {
		try {
			await remove.mutateAsync({ scheduleId });
			toast.success("Removed");
			await refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to remove");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Clock className="size-4" /> Scheduled scaling
				</CardTitle>
				<CardDescription>
					Scale a task group to a fixed count on a cron (e.g. down at night).
					Runs against the Nomad scale API — independent of a redeploy.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
					<div className="space-y-1">
						<Label className="text-xs">Name</Label>
						<Input
							placeholder="night scale-down"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<Label className="text-xs">Group</Label>
						<Select value={group} onValueChange={setGroup}>
							<SelectTrigger>
								<SelectValue placeholder="service" />
							</SelectTrigger>
							<SelectContent>
								{services?.map((s) => (
									<SelectItem key={s} value={s}>
										{s}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1">
						<Label className="text-xs">Count</Label>
						<Input
							type="number"
							min={0}
							value={count}
							onChange={(e) => setCount(Number(e.target.value) || 0)}
						/>
					</div>
					<div className="space-y-1">
						<Label className="text-xs">Cron</Label>
						<Input
							placeholder="0 22 * * *"
							value={cron}
							onChange={(e) => setCron(e.target.value)}
						/>
					</div>
					<div className="flex items-end">
						<Button
							type="button"
							onClick={add}
							disabled={create.isPending}
							className="w-full"
						>
							{create.isPending ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								"Add"
							)}
						</Button>
					</div>
				</div>

				{scaleSchedules.length > 0 && (
					<div className="flex flex-col gap-2">
						{scaleSchedules.map((s) => (
							<div
								key={s.scheduleId}
								className="flex items-center justify-between rounded-md border p-2 text-sm"
							>
								<span>
									<span className="font-medium">{s.name}</span>
									<span className="ml-2 text-muted-foreground">
										{s.serviceName} → {s.scaleCount} · {s.cronExpression}
									</span>
								</span>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={() => del(s.scheduleId)}
								>
									<Trash2 className="size-4 text-destructive" />
								</Button>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
