import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { formatDistanceToNow } from "date-fns";
import { DatabaseBackup, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { RestoreBackup } from "@/components/dashboard/database/backups/restore-backup";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

const schema = z.object({
	destinationId: z.string().min(1, "Destination is required"),
	schedule: z.string().min(1, "Schedule (cron) is required"),
	prefix: z.string(),
	keepLatestCount: z.number().int().min(0),
	enabled: z.boolean(),
});
type Schema = z.infer<typeof schema>;

/**
 * Backups for the control-plane's own Postgres (the panel's database: projects,
 * apps, secret references, cluster state). It runs as a standalone container, so
 * it isn't covered by the per-service database backups — this schedules a
 * pg_dump of it to an S3 destination via the existing web-server backup path.
 */
export const ShowWebServerBackups = () => {
	const [open, setOpen] = useState(false);
	const { data: backups, refetch } = api.backup.listWebServerBackups.useQuery();
	const wsBackupIds = (backups ?? []).map((b) => b.backupId);
	const { data: lastRuns } = api.backup.lastRuns.useQuery(
		{ backupIds: wsBackupIds },
		{ enabled: wsBackupIds.length > 0, refetchInterval: 30000 },
	);
	const { data: destinations } = api.destination.all.useQuery();
	const create = api.backup.create.useMutation();
	const update = api.backup.update.useMutation();
	const remove = api.backup.remove.useMutation();
	const manual = api.backup.manualBackupWebServer.useMutation();

	const form = useForm<Schema>({
		resolver: zodResolver(schema),
		defaultValues: {
			destinationId: "",
			schedule: "0 3 * * *",
			prefix: "control-plane/",
			keepLatestCount: 7,
			enabled: true,
		},
	});

	const onCreate = async (data: Schema) => {
		try {
			await create.mutateAsync({
				destinationId: data.destinationId,
				schedule: data.schedule,
				prefix: data.prefix,
				keepLatestCount: data.keepLatestCount,
				enabled: data.enabled,
				database: "nomploy",
				databaseType: "web-server",
				backupType: "database",
			});
			toast.success("Control-plane backup scheduled");
			setOpen(false);
			form.reset();
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to create backup");
		}
	};

	const hasDestinations = (destinations?.length ?? 0) > 0;

	return (
		<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto mt-4">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader className="flex flex-row items-start justify-between gap-4">
					<div>
						<CardTitle className="text-xl flex flex-row gap-2">
							<DatabaseBackup className="size-6 text-muted-foreground self-center" />
							Control-plane Backups
						</CardTitle>
						<CardDescription>
							Scheduled pg_dump of the panel's own Postgres (projects, apps,
							cluster state) to an S3 destination. Protects against losing the
							control plane if the hub's disk fails.
						</CardDescription>
					</div>
					<Dialog open={open} onOpenChange={setOpen}>
						<DialogTrigger asChild>
							<Button disabled={!hasDestinations}>
								<Plus className="mr-2 h-4 w-4" /> Add backup
							</Button>
						</DialogTrigger>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Schedule control-plane backup</DialogTitle>
								<DialogDescription>
									Dumps the panel's Postgres to the chosen S3 destination on the
									schedule.
								</DialogDescription>
							</DialogHeader>
							<Form {...form}>
								<form
									onSubmit={form.handleSubmit(onCreate)}
									className="space-y-4"
								>
									<FormField
										control={form.control}
										name="destinationId"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Destination</FormLabel>
												<Select
													onValueChange={field.onChange}
													value={field.value}
												>
													<FormControl>
														<SelectTrigger>
															<SelectValue placeholder="Select an S3 destination" />
														</SelectTrigger>
													</FormControl>
													<SelectContent>
														{destinations?.map((d) => (
															<SelectItem
																key={d.destinationId}
																value={d.destinationId}
															>
																{d.name}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="schedule"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Schedule (cron)</FormLabel>
												<FormControl>
													<Input placeholder="0 3 * * *" {...field} />
												</FormControl>
												<FormDescription>
													e.g. <code>0 3 * * *</code> = daily at 03:00.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>
									<div className="grid grid-cols-2 gap-4">
										<FormField
											control={form.control}
											name="prefix"
											render={({ field }) => (
												<FormItem>
													<FormLabel>S3 prefix</FormLabel>
													<FormControl>
														<Input placeholder="control-plane/" {...field} />
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="keepLatestCount"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Keep latest</FormLabel>
													<FormControl>
														<Input
															type="number"
															min={0}
															placeholder="7"
															value={field.value}
															onChange={(e) =>
																field.onChange(
																	Number.isNaN(e.target.valueAsNumber)
																		? 0
																		: e.target.valueAsNumber,
																)
															}
														/>
													</FormControl>
													<FormDescription>0 = keep all.</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									</div>
									<FormField
										control={form.control}
										name="enabled"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
												<FormLabel>Enabled</FormLabel>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
									<Button
										type="submit"
										className="w-full"
										disabled={create.isPending}
									>
										{create.isPending && (
											<Loader2 className="mr-2 h-4 w-4 animate-spin" />
										)}
										Schedule backup
									</Button>
								</form>
							</Form>
						</DialogContent>
					</Dialog>
				</CardHeader>
				<CardContent className="space-y-3 py-6 border-t">
					{!hasDestinations && (
						<AlertBlock type="info">
							Add an S3 destination first (Settings → S3 Destinations), then you
							can schedule a control-plane backup here.
						</AlertBlock>
					)}
					{hasDestinations && (!backups || backups.length === 0) && (
						<p className="text-sm text-muted-foreground">
							No control-plane backups scheduled yet.
						</p>
					)}
					{backups?.map((b) => (
						<div
							key={b.backupId}
							className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
						>
							<div className="min-w-0">
								<div className="font-mono text-sm">{b.schedule}</div>
								<div className="text-xs text-muted-foreground">
									{b.destination?.name ?? "—"}
									{b.prefix ? ` · ${b.prefix}` : ""}
									{b.keepLatestCount ? ` · keep ${b.keepLatestCount}` : ""}
								</div>
								{(() => {
									const run = lastRuns?.[b.backupId];
									return (
										<div className="mt-1 flex items-center gap-1.5 text-xs">
											<span
												className={cn(
													"size-1.5 rounded-full",
													run?.status === "done"
														? "bg-green-500"
														: run?.status === "error"
															? "bg-red-500"
															: run
																? "bg-yellow-500"
																: "bg-muted-foreground/40",
												)}
											/>
											<span
												className={cn(
													"text-muted-foreground",
													run?.status === "error" && "text-red-500",
												)}
											>
												{run
													? `${run.status === "done" ? "OK" : run.status === "error" ? "Failed" : run.status} · ${formatDistanceToNow(new Date(run.ranAt), { addSuffix: true })}`
													: "Never run"}
											</span>
										</div>
									);
								})()}
							</div>
							<div className="flex items-center gap-2">
								<Switch
									checked={!!b.enabled}
									onCheckedChange={async (v) => {
										// apiUpdateBackup isn't partial — echo the row back with the
										// toggled `enabled`.
										await update
											.mutateAsync({
												backupId: b.backupId,
												enabled: v,
												destinationId: b.destinationId,
												schedule: b.schedule,
												prefix: b.prefix,
												keepLatestCount: b.keepLatestCount,
												database: b.database,
												databaseType: b.databaseType,
												serviceName: b.serviceName,
												metadata: b.metadata,
											})
											.then(() => refetch())
											.catch((e) =>
												toast.error(
													e instanceof Error ? e.message : "Failed to update",
												),
											);
									}}
								/>
								<Button
									variant="outline"
									size="sm"
									disabled={manual.isPending}
									onClick={async () => {
										await manual
											.mutateAsync({ backupId: b.backupId })
											.then(() => toast.success("Backup started"))
											.catch((e) =>
												toast.error(
													e instanceof Error ? e.message : "Backup failed",
												),
											);
									}}
								>
									<Play className="mr-2 h-3.5 w-3.5" /> Backup now
								</Button>
								<RestoreBackup id="web-server" databaseType="web-server" />
								<DialogAction
									title="Delete this backup schedule?"
									description="The schedule is removed. Existing backup files in S3 are not deleted."
									type="destructive"
									onClick={async () => {
										await remove
											.mutateAsync({ backupId: b.backupId })
											.then(() => {
												toast.success("Backup schedule deleted");
												refetch();
											})
											.catch((e) =>
												toast.error(
													e instanceof Error ? e.message : "Failed to delete",
												),
											);
									}}
								>
									<Button variant="ghost" size="icon">
										<Trash2 className="h-4 w-4 text-destructive" />
									</Button>
								</DialogAction>
							</div>
						</div>
					))}
				</CardContent>
			</div>
		</Card>
	);
};
