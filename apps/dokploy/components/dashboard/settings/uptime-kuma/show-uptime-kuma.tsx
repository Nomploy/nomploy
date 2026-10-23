import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import {
	Activity,
	CheckCircle2,
	CircleDashed,
	Loader2,
	RefreshCw,
	Trash2,
	XCircle,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

const Schema = z.object({
	baseUrl: z.string().url({ message: "Enter the full URL incl. https://" }),
	username: z.string().min(1, { message: "Username is required" }),
	password: z.string().optional(),
});
type Values = z.infer<typeof Schema>;

/** Up/down badge for a single monitor (status: 1=up 0=down 2=pending 3=maint). */
const MonitorStatus = ({ status }: { status: number | null }) => {
	if (status === 1)
		return (
			<Badge
				variant="outline"
				className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
			>
				<CheckCircle2 className="mr-1 size-3" /> Up
			</Badge>
		);
	if (status === 0)
		return (
			<Badge
				variant="outline"
				className="border-destructive/40 text-destructive"
			>
				<XCircle className="mr-1 size-3" /> Down
			</Badge>
		);
	return (
		<Badge
			variant="outline"
			className="border-muted-foreground/30 text-muted-foreground"
		>
			<CircleDashed className="mr-1 size-3" />
			{status === 3 ? "Maint." : "Pending"}
		</Badge>
	);
};

const MonitorList = () => {
	const { data, isLoading, refetch, isRefetching } =
		api.uptimeKuma.status.useQuery(undefined, { refetchInterval: 30000 });

	if (isLoading)
		return (
			<p className="flex items-center gap-2 text-muted-foreground text-sm">
				<Loader2 className="size-4 animate-spin" /> Loading monitors…
			</p>
		);

	if (!data?.connected)
		return (
			<p className="text-sm text-destructive">
				Could not reach Uptime Kuma{data?.error ? ` — ${data.error}` : ""}.
			</p>
		);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between">
				<p className="text-muted-foreground text-sm">
					{data.monitors.length} monitor(s)
				</p>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => refetch()}
					disabled={isRefetching}
				>
					<RefreshCw
						className={`size-3.5 ${isRefetching ? "animate-spin" : ""}`}
					/>
				</Button>
			</div>
			{data.monitors.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					No monitors yet — they are created as domains are pointed at the
					LoadBalancer.
				</p>
			) : (
				<div className="flex flex-col divide-y rounded-lg border">
					{data.monitors.map((m) => (
						<div
							key={m.id}
							className="flex items-center justify-between gap-3 p-2.5"
						>
							<div className="min-w-0">
								<p className="truncate font-medium text-sm">{m.name}</p>
								<p className="truncate text-muted-foreground text-xs">
									{m.url}
								</p>
							</div>
							<div className="flex items-center gap-2">
								{m.managed && (
									<Badge variant="secondary" className="text-xs">
										Nomploy
									</Badge>
								)}
								<MonitorStatus status={m.status} />
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
};

export const ShowUptimeKuma = () => {
	const utils = api.useUtils();
	const { data, isLoading } = api.uptimeKuma.get.useQuery();
	const {
		mutateAsync: connect,
		isError,
		error,
	} = api.uptimeKuma.connect.useMutation();
	const { mutateAsync: update } = api.uptimeKuma.update.useMutation();
	const { mutateAsync: syncNow, isPending: isSyncing } =
		api.uptimeKuma.syncNow.useMutation();
	const { mutateAsync: remove, isPending: isRemoving } =
		api.uptimeKuma.remove.useMutation();

	const form = useForm<Values>({
		values: {
			baseUrl: data?.baseUrl ?? "",
			username: data?.username ?? "",
			password: "",
		},
		resolver: zodResolver(Schema),
	});

	const connected = !!data;

	const onSubmit = async (values: Values) => {
		await connect({
			baseUrl: values.baseUrl,
			username: values.username,
			password: values.password?.trim() ? values.password : undefined,
			autoMonitor: data?.autoMonitor ?? true,
		})
			.then(async (res) => {
				await utils.uptimeKuma.get.invalidate();
				await utils.uptimeKuma.status.invalidate();
				toast.success(
					`Connected to Uptime Kuma — ${res.monitorCount} existing monitor(s)`,
				);
				form.setValue("password", "");
			})
			.catch((e) => toast.error(e?.message || "Could not connect"));
	};

	const toggle = async (patch: {
		enabled?: boolean;
		autoMonitor?: boolean;
		attachDefaultNotifications?: boolean;
	}) => {
		await update(patch)
			.then(async () => {
				await utils.uptimeKuma.get.invalidate();
			})
			.catch((e) => toast.error(e?.message || "Update failed"));
	};

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<CardHeader>
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-center gap-2">
							<Activity className="size-5" />
							<CardTitle className="text-xl">Uptime Kuma</CardTitle>
							{connected && (
								<Badge
									variant="outline"
									className={
										data.enabled
											? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
											: "border-muted-foreground/30 text-muted-foreground"
									}
								>
									{data.enabled ? "Enabled" : "Disabled"}
								</Badge>
							)}
						</div>
						{connected && (
							<div className="flex items-center gap-2">
								<Button
									variant="secondary"
									size="sm"
									onClick={() =>
										syncNow()
											.then((r) => {
												utils.uptimeKuma.status.invalidate();
												toast.success(
													`Synced — ${r.added} added, ${r.removed} removed`,
												);
											})
											.catch((e) => toast.error(e?.message || "Sync failed"))
									}
									disabled={isSyncing}
								>
									<RefreshCw
										className={`mr-1 size-3.5 ${isSyncing ? "animate-spin" : ""}`}
									/>
									Sync now
								</Button>
								<DialogAction
									title="Disconnect Uptime Kuma?"
									description="Nomploy will stop managing monitors. Existing monitors in Uptime Kuma are left untouched."
									onClick={async () => {
										await remove();
										await utils.uptimeKuma.get.invalidate();
										toast.success("Disconnected");
									}}
								>
									<Button variant="ghost" size="sm" isLoading={isRemoving}>
										<Trash2 className="size-3.5 text-destructive" />
									</Button>
								</DialogAction>
							</div>
						)}
					</div>
					<CardDescription>
						Keep an external{" "}
						<a
							href="https://github.com/louislam/uptime-kuma"
							target="_blank"
							rel="noreferrer"
							className="underline"
						>
							Uptime Kuma
						</a>{" "}
						in sync with your pointed domains: a monitor is created for each
						custom domain and removed when the domain is gone.
					</CardDescription>
				</CardHeader>

				<CardContent className="flex flex-col gap-6">
					{isError && (
						<div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">
							{error?.message}
						</div>
					)}

					<Form {...form}>
						<form
							onSubmit={form.handleSubmit(onSubmit)}
							className="grid w-full gap-4"
						>
							<FormField
								control={form.control}
								name="baseUrl"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Instance URL</FormLabel>
										<FormDescription>
											The public URL of your Uptime Kuma, e.g.{" "}
											<code>https://uptime.example.com</code>.
										</FormDescription>
										<FormControl>
											<Input
												placeholder="https://uptime.example.com"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="username"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Admin username</FormLabel>
										<FormControl>
											<Input placeholder="admin" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="password"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Admin password</FormLabel>
										<FormDescription>
											Uptime Kuma has no API token for monitor management, so an
											admin login is used (2FA must be off).
											{connected && " Leave blank to keep the stored password."}
										</FormDescription>
										<FormControl>
											<Input
												type="password"
												placeholder={connected ? "••••••••" : "password"}
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<div>
								<Button isLoading={form.formState.isSubmitting} type="submit">
									{connected ? "Save & test connection" : "Connect"}
								</Button>
							</div>
						</form>
					</Form>

					{connected && (
						<>
							<div className="flex flex-col gap-3 rounded-lg border p-3">
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="font-medium text-sm">Enabled</p>
										<p className="text-muted-foreground text-xs">
											Turn syncing on or off without disconnecting.
										</p>
									</div>
									<Switch
										checked={data.enabled}
										onCheckedChange={(v) => toggle({ enabled: v })}
									/>
								</div>
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="font-medium text-sm">Auto-monitor domains</p>
										<p className="text-muted-foreground text-xs">
											Create/remove monitors automatically as domains change.
										</p>
									</div>
									<Switch
										checked={data.autoMonitor}
										onCheckedChange={(v) => toggle({ autoMonitor: v })}
									/>
								</div>
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="font-medium text-sm">
											Use default notifications
										</p>
										<p className="text-muted-foreground text-xs">
											Attach Uptime Kuma's "Default" notifications to created
											monitors so they alert (e.g. Slack).
										</p>
									</div>
									<Switch
										checked={data.attachDefaultNotifications}
										onCheckedChange={(v) =>
											toggle({ attachDefaultNotifications: v })
										}
									/>
								</div>
								{data.lastSyncStatus && (
									<p className="text-muted-foreground text-xs">
										Last sync: {data.lastSyncStatus}
										{data.lastSyncAt
											? ` · ${new Date(data.lastSyncAt).toLocaleString()}`
											: ""}
									</p>
								)}
							</div>

							<div className="flex flex-col gap-2">
								<p className="font-medium text-sm">Monitors</p>
								<MonitorList />
							</div>
						</>
					)}

					{!connected && isLoading && (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" /> Loading…
						</p>
					)}
				</CardContent>
			</Card>
		</div>
	);
};
