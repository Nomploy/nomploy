import {
	AlertTriangle,
	Bell,
	ChevronDown,
	Pencil,
	Plus,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ReferenceLine,
	XAxis,
	YAxis,
} from "recharts";
import { toast } from "sonner";
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
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

type Rule = {
	alertRuleId: string;
	name: string;
	metric: string;
	target: string | null;
	comparator: string;
	threshold: number;
	severity: string;
	forMinutes: number;
	enabled: boolean;
	state: string;
	lastValue: number | null;
};

const SEVERITIES = [
	{ value: "critical", label: "Critical" },
	{ value: "warning", label: "Warning" },
	{ value: "info", label: "Info" },
];

const severityBadge = (s: string) =>
	s === "critical"
		? "border-destructive/40 text-destructive"
		: s === "warning"
			? "border-amber-500/40 text-amber-600 dark:text-amber-400"
			: "border-sky-500/40 text-sky-500";

const chartConfig = {
	value: { label: "Value", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

/** SigNoz-style metric graph with the alert threshold drawn as a reference line. */
const MetricChart = ({
	metric,
	target,
	needsTarget,
	threshold,
	comparator,
	minutes = 360,
	height = "h-40",
}: {
	metric: string;
	target: string | null;
	needsTarget: boolean;
	threshold: number;
	comparator: string;
	minutes?: number;
	height?: string;
}) => {
	const { data, isPending } = api.alert.metricHistory.useQuery(
		{ metric, target, minutes },
		{ enabled: !!metric && (!needsTarget || !!target), refetchInterval: 30000 },
	);
	const points = data?.points ?? [];
	const unit = data?.unit ?? "";
	const breached = (v: number) =>
		comparator === "gt" ? v > threshold : v < threshold;

	if (!metric || (needsTarget && !target)) {
		return (
			<div
				className={`flex ${height} items-center justify-center rounded-lg border text-muted-foreground text-xs`}
			>
				Pick a service to preview
			</div>
		);
	}
	if (points.length < 2) {
		return (
			<div
				className={`flex ${height} items-center justify-center rounded-lg border text-muted-foreground text-xs`}
			>
				{isPending ? "Loading…" : "Not enough data yet"}
			</div>
		);
	}
	return (
		<ChartContainer config={chartConfig} className={`${height} w-full`}>
			<LineChart
				data={points}
				margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
			>
				<CartesianGrid vertical={false} />
				<XAxis
					dataKey="ts"
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					minTickGap={40}
					tickFormatter={(t) =>
						new Date(t).toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit",
						})
					}
				/>
				<YAxis
					tickLine={false}
					axisLine={false}
					width={34}
					// Always keep the threshold line in view: without this the axis
					// auto-scales to the data, so a threshold above the current max
					// (e.g. 10 req/s when traffic is ~4) falls off the top and is
					// invisible. Add ~10% headroom above whichever is larger.
					domain={[0, (dataMax: number) => Math.max(dataMax, threshold) * 1.1]}
					allowDecimals={false}
				/>
				<ChartTooltip
					content={
						<ChartTooltipContent
							labelFormatter={(_, p) => {
								const t = p?.[0]?.payload?.ts;
								return t ? new Date(t).toLocaleString() : "";
							}}
							formatter={(v) => [`${Number(v).toFixed(1)}${unit}`, "value"]}
						/>
					}
				/>
				<ReferenceLine
					y={threshold}
					stroke="hsl(0 84% 60%)"
					strokeDasharray="5 4"
					label={{
						value: `threshold ${threshold}${unit}`,
						position: "insideTopRight",
						fontSize: 10,
						fill: "hsl(0 84% 60%)",
					}}
				/>
				<Line
					type="monotone"
					dataKey="value"
					stroke="var(--color-value)"
					strokeWidth={2}
					dot={(props) => {
						const { cx, cy, payload, index } = props;
						if (cx == null || cy == null || !breached(payload.value))
							return <g key={index} />;
						return (
							<circle
								key={index}
								cx={cx}
								cy={cy}
								r={2.5}
								fill="hsl(0 84% 60%)"
							/>
						);
					}}
				/>
			</LineChart>
		</ChartContainer>
	);
};

const RuleDialog = ({
	rule,
	trigger,
	onDone,
}: {
	rule?: Rule;
	trigger: React.ReactNode;
	onDone: () => void;
}) => {
	const [open, setOpen] = useState(false);
	const { data: metrics } = api.alert.metrics.useQuery();
	const { data: targets } = api.alert.targets.useQuery(undefined, {
		enabled: open,
	});
	const create = api.alert.create.useMutation();
	const update = api.alert.update.useMutation();

	const [name, setName] = useState("");
	const [metric, setMetric] = useState("lb_5xx_per_sec");
	const [target, setTarget] = useState("");
	const [comparator, setComparator] = useState<"gt" | "lt">("gt");
	const [threshold, setThreshold] = useState(1);
	const [severity, setSeverity] = useState("warning");
	const [forMinutes, setForMinutes] = useState(5);

	// Seed the form when opening.
	useEffect(() => {
		if (!open) return;
		if (rule) {
			setName(rule.name);
			setMetric(rule.metric);
			setTarget(rule.target ?? "");
			setComparator(rule.comparator === "lt" ? "lt" : "gt");
			setThreshold(rule.threshold);
			setSeverity(rule.severity ?? "warning");
			setForMinutes(rule.forMinutes);
		} else {
			setName("");
			setMetric("lb_5xx_per_sec");
			setTarget("");
			setComparator("gt");
			setThreshold(1);
			setSeverity("warning");
			setForMinutes(5);
		}
	}, [open, rule]);

	const meta = (metrics ?? []).find((m) => m.metric === metric);
	const needsTarget = !!meta?.needsTarget;
	const unit = meta?.unit ?? "";

	const onMetricChange = (m: string) => {
		setMetric(m);
		const md = (metrics ?? []).find((x) => x.metric === m);
		if (md && !rule) {
			setComparator(md.defaultComparator);
			setThreshold(md.defaultThreshold);
		}
	};

	const submit = async () => {
		if (!name.trim()) return toast.error("Name is required");
		if (needsTarget && !target.trim())
			return toast.error("This metric needs a target service (Nomad job id)");
		const payload = {
			name: name.trim(),
			metric: metric as never,
			target: needsTarget ? target.trim() : null,
			comparator,
			threshold,
			severity: severity as never,
			forMinutes,
			enabled: rule?.enabled ?? true,
		};
		try {
			if (rule) {
				await update.mutateAsync({ alertRuleId: rule.alertRuleId, ...payload });
			} else {
				await create.mutateAsync(payload);
			}
			toast.success(rule ? "Rule updated" : "Rule created");
			setOpen(false);
			onDone();
		} catch (e) {
			toast.error("Save failed", { description: (e as Error).message });
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{rule ? "Edit alert rule" : "New alert rule"}
					</DialogTitle>
					<DialogDescription>
						Fire when the metric stays past the threshold for the chosen window.
					</DialogDescription>
				</DialogHeader>
				{/* Live preview — the metric with the threshold drawn on it (SigNoz-style). */}
				<div className="flex flex-col gap-1.5 rounded-lg border p-3">
					<span className="text-muted-foreground text-xs">
						Preview (last 6h)
					</span>
					<MetricChart
						metric={metric}
						target={needsTarget ? target : null}
						needsTarget={needsTarget}
						threshold={threshold}
						comparator={comparator}
					/>
				</div>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label>Name</Label>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. LB 5xx spike"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Metric</Label>
						<Select value={metric} onValueChange={onMetricChange}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(metrics ?? []).map((m) => (
									<SelectItem key={m.metric} value={m.metric}>
										{m.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{needsTarget && (
						<div className="flex flex-col gap-1.5">
							<Label>Target service</Label>
							<Select value={target} onValueChange={setTarget}>
								<SelectTrigger>
									<SelectValue placeholder="Select a service" />
								</SelectTrigger>
								<SelectContent>
									{(targets ?? []).length === 0 ? (
										<SelectItem value="__none" disabled>
											No services with metrics yet
										</SelectItem>
									) : (
										(targets ?? []).map((t) => (
											<SelectItem key={t.appName} value={t.appName}>
												{t.label}
											</SelectItem>
										))
									)}
								</SelectContent>
							</Select>
						</div>
					)}
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						<div className="flex flex-col gap-1.5">
							<Label>Condition</Label>
							<Select
								value={comparator}
								onValueChange={(v) => setComparator(v as "gt" | "lt")}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="gt">above</SelectItem>
									<SelectItem value="lt">below</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Threshold {unit && `(${unit})`}</Label>
							<Input
								type="number"
								value={threshold}
								onChange={(e) => setThreshold(Number(e.target.value))}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>For (min)</Label>
							<Input
								type="number"
								min={1}
								value={forMinutes}
								onChange={(e) => setForMinutes(Number(e.target.value) || 1)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Severity</Label>
							<Select value={severity} onValueChange={setSeverity}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SEVERITIES.map((s) => (
										<SelectItem key={s.value} value={s.value}>
											{s.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>
				<DialogFooter>
					<Button
						onClick={submit}
						isLoading={create.isPending || update.isPending}
					>
						{rule ? "Save" : "Create rule"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const RuleRow = ({
	rule: r,
	canManage,
	needsTarget,
	metricLabel,
	metricUnit,
	refetch,
}: {
	rule: Rule;
	canManage: boolean;
	needsTarget: boolean;
	metricLabel: string;
	metricUnit: string;
	refetch: () => void;
}) => {
	const [open, setOpen] = useState(false);
	const setEnabled = api.alert.setEnabled.useMutation();
	const remove = api.alert.delete.useMutation();

	return (
		<div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex flex-col gap-0.5">
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={() => setOpen((v) => !v)}
							className="flex items-center gap-1 font-medium hover:underline"
						>
							<ChevronDown
								className={`size-4 text-muted-foreground transition-transform ${
									open ? "rotate-180" : ""
								}`}
							/>
							{r.name}
						</button>
						<Badge variant="outline" className={severityBadge(r.severity)}>
							{r.severity}
						</Badge>
						<Badge
							variant="outline"
							className={
								!r.enabled
									? "text-muted-foreground"
									: r.state === "firing"
										? "border-destructive/40 text-destructive"
										: "border-emerald-500/40 text-emerald-500"
							}
						>
							{!r.enabled ? "disabled" : r.state}
						</Badge>
					</div>
					<span className="pl-5 text-muted-foreground text-xs">
						{metricLabel}
						{r.target ? ` [${r.target}]` : ""}{" "}
						{r.comparator === "gt" ? ">" : "<"} {r.threshold}
						{metricUnit} · {r.forMinutes}m
						{r.lastValue != null &&
							` · now ${r.lastValue.toFixed(1)}${metricUnit}`}
					</span>
				</div>
				{canManage && (
					<div className="flex items-center gap-2">
						<Switch
							checked={r.enabled}
							onCheckedChange={async (enabled) => {
								await setEnabled
									.mutateAsync({ alertRuleId: r.alertRuleId, enabled })
									.then(() => refetch())
									.catch((e) =>
										toast.error("Failed", { description: e.message }),
									);
							}}
						/>
						<RuleDialog
							rule={r}
							trigger={
								<Button size="sm" variant="outline">
									<Pencil className="size-4" />
								</Button>
							}
							onDone={refetch}
						/>
						<DialogAction
							title="Delete alert rule"
							description={`Delete "${r.name}"? This can't be undone.`}
							type="destructive"
							onClick={async () => {
								await remove
									.mutateAsync({ alertRuleId: r.alertRuleId })
									.then(() => {
										toast.success("Rule deleted");
										refetch();
									})
									.catch((e) =>
										toast.error("Delete failed", { description: e.message }),
									);
							}}
						>
							<Button size="sm" variant="outline">
								<Trash2 className="size-4 text-destructive" />
							</Button>
						</DialogAction>
					</div>
				)}
			</div>
			{open && (
				<MetricChart
					metric={r.metric}
					target={r.target}
					needsTarget={needsTarget}
					threshold={r.threshold}
					comparator={r.comparator}
				/>
			)}
		</div>
	);
};

export const ShowAlerts = () => {
	const { data: rules, refetch } = api.alert.list.useQuery(undefined, {
		refetchInterval: 15000,
	});
	const { data: events } = api.alert.events.useQuery(
		{ limit: 30 },
		{ refetchInterval: 15000 },
	);
	const { data: metrics } = api.alert.metrics.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canManage = !!permissions?.server?.create;

	const list = (rules ?? []) as Rule[];
	const firing = list.filter((r) => r.state === "firing" && r.enabled);
	const metricLabel = (m: string) =>
		(metrics ?? []).find((x) => x.metric === m)?.label ?? m;
	const metricUnit = (m: string) =>
		(metrics ?? []).find((x) => x.metric === m)?.unit ?? "";

	return (
		<div className="flex flex-col gap-4">
			{firing.length > 0 && (
				<Card className="border-destructive/40 bg-destructive/5">
					<CardHeader className="pb-3">
						<CardTitle className="flex items-center gap-2 text-lg text-destructive">
							<AlertTriangle className="size-5" />
							{firing.length} active alert{firing.length > 1 ? "s" : ""}
						</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-2">
						{firing.map((r) => (
							<div
								key={r.alertRuleId}
								className="flex items-center justify-between rounded-lg border border-destructive/30 p-2.5 text-sm"
							>
								<span className="font-medium">{r.name}</span>
								<span className="text-muted-foreground text-xs">
									{metricLabel(r.metric)}
									{r.target ? ` [${r.target}]` : ""} = {r.lastValue?.toFixed(1)}
									{metricUnit(r.metric)}
								</span>
							</div>
						))}
					</CardContent>
				</Card>
			)}

			<Card className="bg-background">
				<CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
					<div className="flex flex-col gap-0.5">
						<CardTitle className="flex flex-row gap-2 text-xl">
							<Bell className="size-5 self-center text-muted-foreground" />
							Alert rules
						</CardTitle>
						<CardDescription>
							Notify via your cluster-alert channels when a metric crosses a
							threshold for a sustained window.
						</CardDescription>
					</div>
					{canManage && (
						<RuleDialog
							trigger={
								<Button size="sm">
									<Plus className="mr-1 size-4" /> New rule
								</Button>
							}
							onDone={refetch}
						/>
					)}
				</CardHeader>
				<CardContent>
					{list.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No alert rules yet. Create one to get notified on 5xx spikes, high
							latency, or a service running hot.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							{list.map((r) => (
								<RuleRow
									key={r.alertRuleId}
									rule={r}
									canManage={canManage}
									needsTarget={
										(metrics ?? []).find((m) => m.metric === r.metric)
											?.needsTarget ?? false
									}
									metricLabel={metricLabel(r.metric)}
									metricUnit={metricUnit(r.metric)}
									refetch={refetch}
								/>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">Recent events</CardTitle>
					<CardDescription>Fired and resolved alerts.</CardDescription>
				</CardHeader>
				<CardContent>
					{(events ?? []).length === 0 ? (
						<p className="text-muted-foreground text-sm">No events yet.</p>
					) : (
						<div className="flex flex-col gap-1.5">
							{(events ?? []).map((e) => (
								<div
									key={e.alertEventId}
									className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
								>
									<div className="flex items-center gap-2">
										<Badge
											variant="outline"
											className={
												e.type === "fired"
													? "border-destructive/40 text-destructive"
													: "border-emerald-500/40 text-emerald-500"
											}
										>
											{e.type}
										</Badge>
										<span className="text-muted-foreground text-xs">
											{e.message}
										</span>
									</div>
									<span className="shrink-0 text-muted-foreground text-xs">
										{new Date(e.createdAt).toLocaleString()}
									</span>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
};
