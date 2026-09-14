import { CalendarClock, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface ScheduleRow {
	scheduleId: string;
	name: string;
	cronExpression: string;
	desiredNodes: number;
	minNodes: number | null;
	maxNodes: number | null;
	timezone: string;
	enabled: boolean;
}

interface FormState {
	name: string;
	cronExpression: string;
	desiredNodes: number;
	minNodes: string;
	maxNodes: string;
	timezone: string;
	enabled: boolean;
}

const emptyForm: FormState = {
	name: "",
	cronExpression: "0 9 * * 1-5",
	desiredNodes: 1,
	minNodes: "",
	maxNodes: "",
	timezone: "UTC",
	enabled: true,
};

/**
 * Scheduled scaling actions for one group: each fires a cron and sets the group's
 * desired count (optionally overriding min/max), then the autoscaler converges.
 */
export const AutoscalingSchedules = ({ groupId }: { groupId: string }) => {
	const { data, refetch } = api.nomad.listAutoscalingSchedules.useQuery({
		groupId,
	});
	const upsert = api.nomad.upsertAutoscalingSchedule.useMutation();
	const remove = api.nomad.deleteAutoscalingSchedule.useMutation();

	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [form, setForm] = useState<FormState>(emptyForm);

	const schedules = (data ?? []) as ScheduleRow[];

	const openNew = () => {
		setEditing(null);
		setForm(emptyForm);
		setOpen(true);
	};
	const openEdit = (s: ScheduleRow) => {
		setEditing(s.scheduleId);
		setForm({
			name: s.name,
			cronExpression: s.cronExpression,
			desiredNodes: s.desiredNodes,
			minNodes: s.minNodes?.toString() ?? "",
			maxNodes: s.maxNodes?.toString() ?? "",
			timezone: s.timezone || "UTC",
			enabled: s.enabled,
		});
		setOpen(true);
	};

	const save = async () => {
		if (!form.name.trim() || !form.cronExpression.trim()) {
			toast.error("Name and cron are required");
			return;
		}
		try {
			await upsert.mutateAsync({
				scheduleId: editing ?? undefined,
				autoscalerId: groupId,
				name: form.name.trim(),
				cronExpression: form.cronExpression.trim(),
				desiredNodes: Math.max(0, form.desiredNodes),
				minNodes: form.minNodes === "" ? null : Number(form.minNodes),
				maxNodes: form.maxNodes === "" ? null : Number(form.maxNodes),
				timezone: form.timezone.trim() || "UTC",
				enabled: form.enabled,
			});
			toast.success(editing ? "Schedule updated" : "Schedule created");
			setOpen(false);
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save schedule");
		}
	};

	return (
		<div className="space-y-2 rounded-lg border p-3">
			<div className="flex items-center justify-between">
				<Label className="flex items-center gap-1.5 text-sm">
					<CalendarClock className="h-4 w-4" /> Scheduled actions
				</Label>
				<Dialog open={open} onOpenChange={setOpen}>
					<DialogTrigger asChild>
						<Button type="button" size="sm" variant="outline" onClick={openNew}>
							<Plus className="mr-2 h-3.5 w-3.5" /> Add
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								{editing ? "Edit scheduled action" : "New scheduled action"}
							</DialogTitle>
						</DialogHeader>
						<div className="space-y-3">
							<div className="space-y-1.5">
								<Label>Name</Label>
								<Input
									placeholder="Weekday mornings"
									value={form.name}
									onChange={(e) => setForm({ ...form, name: e.target.value })}
								/>
							</div>
							<div className="space-y-1.5">
								<Label>Cron</Label>
								<Input
									placeholder="0 9 * * 1-5"
									value={form.cronExpression}
									onChange={(e) =>
										setForm({ ...form, cronExpression: e.target.value })
									}
								/>
								<p className="text-xs text-muted-foreground">
									e.g. <code>0 9 * * 1-5</code> = 09:00 Mon–Fri.
								</p>
							</div>
							<div className="grid grid-cols-2 gap-3">
								<div className="space-y-1.5">
									<Label>Desired nodes</Label>
									<Input
										type="number"
										min={0}
										value={form.desiredNodes}
										onChange={(e) =>
											setForm({
												...form,
												desiredNodes: Number.isNaN(e.target.valueAsNumber)
													? 0
													: e.target.valueAsNumber,
											})
										}
									/>
								</div>
								<div className="space-y-1.5">
									<Label>Timezone</Label>
									<Input
										placeholder="UTC"
										value={form.timezone}
										onChange={(e) =>
											setForm({ ...form, timezone: e.target.value })
										}
									/>
								</div>
								<div className="space-y-1.5">
									<Label>Min override (optional)</Label>
									<Input
										type="number"
										min={0}
										value={form.minNodes}
										onChange={(e) =>
											setForm({ ...form, minNodes: e.target.value })
										}
									/>
								</div>
								<div className="space-y-1.5">
									<Label>Max override (optional)</Label>
									<Input
										type="number"
										min={0}
										value={form.maxNodes}
										onChange={(e) =>
											setForm({ ...form, maxNodes: e.target.value })
										}
									/>
								</div>
							</div>
							<div className="flex items-center justify-between rounded-lg border p-3">
								<Label>Enabled</Label>
								<Switch
									checked={form.enabled}
									onCheckedChange={(v) => setForm({ ...form, enabled: v })}
								/>
							</div>
							<Button
								type="button"
								className="w-full"
								onClick={save}
								disabled={upsert.isPending}
							>
								{upsert.isPending && (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								)}
								{editing ? "Save" : "Create"}
							</Button>
						</div>
					</DialogContent>
				</Dialog>
			</div>

			{schedules.length === 0 && (
				<p className="text-xs text-muted-foreground">
					No scheduled actions. Add one to set the desired count on a cron (e.g.
					scale up for business hours, down overnight).
				</p>
			)}
			{schedules.map((s) => (
				<div
					key={s.scheduleId}
					className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background px-2.5 py-1.5 text-sm"
				>
					<button
						type="button"
						className="min-w-0 text-left"
						onClick={() => openEdit(s)}
					>
						<span className="font-medium">{s.name}</span>{" "}
						<span className="font-mono text-xs text-muted-foreground">
							{s.cronExpression} {s.timezone}
						</span>
						<span className="text-xs text-muted-foreground">
							{" "}
							→ desired {s.desiredNodes}
							{s.minNodes != null || s.maxNodes != null
								? ` (min ${s.minNodes ?? "—"} / max ${s.maxNodes ?? "—"})`
								: ""}
						</span>
					</button>
					<div className="flex items-center gap-1.5">
						{!s.enabled && <Badge variant="outline">disabled</Badge>}
						<DialogAction
							title={`Delete schedule "${s.name}"?`}
							description="The cron action is removed."
							type="destructive"
							onClick={async () => {
								await remove
									.mutateAsync({ scheduleId: s.scheduleId })
									.then(() => {
										toast.success("Schedule deleted");
										refetch();
									})
									.catch((e) =>
										toast.error(
											e instanceof Error ? e.message : "Failed to delete",
										),
									);
							}}
						>
							<Button variant="ghost" size="icon" className="h-7 w-7">
								<Trash2 className="h-3.5 w-3.5 text-destructive" />
							</Button>
						</DialogAction>
					</div>
				</div>
			))}
		</div>
	);
};
