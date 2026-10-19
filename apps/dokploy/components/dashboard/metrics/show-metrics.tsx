import { format } from "date-fns";
import { Activity } from "lucide-react";
import { useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ReferenceLine,
	XAxis,
	YAxis,
} from "recharts";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

type MetricMeta = {
	metric: string;
	label: string;
	unit: string;
	needsTarget: boolean;
};
type Rule = {
	alertRuleId: string;
	name: string;
	metric: string;
	target: string | null;
	threshold: number;
	comparator: string;
	state: string | null;
};

const RANGES = [
	{ label: "1h", minutes: 60 },
	{ label: "6h", minutes: 360 },
	{ label: "24h", minutes: 1440 },
];

const chartConfig = {
	value: { label: "value", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

const fmtValue = (v: number, unit: string) => {
	const n =
		Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
	return unit === "€/mo" ? `${n} €/mo` : `${n} ${unit}`;
};

const MetricChart = ({
	meta,
	target,
	minutes,
	rules,
}: {
	meta: MetricMeta;
	target: string | null;
	minutes: number;
	rules: Rule[];
}) => {
	const { data } = api.alert.metricHistory.useQuery(
		{ metric: meta.metric, target, minutes },
		{ refetchInterval: 30000 },
	);
	const points = (data?.points ?? []).map((p) => ({
		time: p.ts,
		value: p.value,
	}));
	const latest = points.at(-1)?.value;

	// Thresholds from rules on this exact metric (+ target, when the metric is
	// scoped) — drawn as reference lines so you see what you're alerting on.
	const myRules = rules.filter(
		(r) =>
			r.metric === meta.metric &&
			(meta.needsTarget ? r.target === target : true),
	);
	const firing = myRules.some((r) => r.state === "firing");

	return (
		<Card className="bg-background">
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between">
					<CardTitle className="text-base">{meta.label}</CardTitle>
					<span
						className={`text-sm font-medium ${firing ? "text-destructive" : "text-muted-foreground"}`}
					>
						{latest != null ? fmtValue(latest, meta.unit) : "—"}
					</span>
				</div>
				{myRules.length > 0 && (
					<CardDescription>
						{myRules
							.map(
								(r) =>
									`${r.name}: ${r.comparator === "gt" ? ">" : "<"} ${fmtValue(r.threshold, meta.unit)}`,
							)
							.join(" · ")}
					</CardDescription>
				)}
			</CardHeader>
			<CardContent>
				{points.length < 2 ? (
					<p className="py-10 text-center text-sm text-muted-foreground">
						Collecting samples…
					</p>
				) : (
					<ChartContainer config={chartConfig} className="h-[180px] w-full">
						<AreaChart data={points} margin={{ left: 4, right: 8, top: 8 }}>
							<CartesianGrid vertical={false} />
							<XAxis
								dataKey="time"
								tickFormatter={(t) =>
									format(new Date(t), minutes > 720 ? "MM/dd HH:mm" : "HH:mm")
								}
								tickLine={false}
								axisLine={false}
								minTickGap={40}
							/>
							<YAxis
								tickLine={false}
								axisLine={false}
								width={40}
								allowDecimals={false}
							/>
							<ChartTooltip content={<ChartTooltipContent />} />
							{myRules.map((r) => (
								<ReferenceLine
									key={r.alertRuleId}
									y={r.threshold}
									stroke="hsl(var(--destructive))"
									strokeDasharray="4 4"
									strokeOpacity={0.7}
								/>
							))}
							<Area
								dataKey="value"
								type="monotone"
								stroke="var(--color-value)"
								fill="var(--color-value)"
								fillOpacity={0.15}
								isAnimationActive={false}
							/>
						</AreaChart>
					</ChartContainer>
				)}
			</CardContent>
		</Card>
	);
};

export const ShowMetrics = () => {
	const [minutes, setMinutes] = useState(360);
	const [serviceTarget, setServiceTarget] = useState<string | null>(null);
	const [projectTarget, setProjectTarget] = useState<string | null>(null);

	const { data: metrics } = api.alert.metrics.useQuery();
	const { data: rules } = api.alert.list.useQuery();
	const { data: services } = api.alert.targets.useQuery();
	const { data: projects } = api.cost.projectTargets.useQuery();

	const allRules = (rules ?? []) as unknown as Rule[];
	const metas = (metrics ?? []) as MetricMeta[];
	const globalMetrics = metas.filter(
		(m) => !m.needsTarget && m.metric !== "cost_project_monthly",
	);
	const serviceMetrics = metas.filter((m) => m.metric.startsWith("service_"));
	const projectCostMetric = metas.find(
		(m) => m.metric === "cost_project_monthly",
	);

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<Activity className="size-6 text-muted-foreground" />
					<h1 className="text-2xl font-semibold">Metrics</h1>
				</div>
				<div className="flex gap-1">
					{RANGES.map((r) => (
						<Button
							key={r.minutes}
							type="button"
							size="sm"
							variant={minutes === r.minutes ? "default" : "outline"}
							onClick={() => setMinutes(r.minutes)}
						>
							{r.label}
						</Button>
					))}
				</div>
			</div>
			<p className="text-sm text-muted-foreground">
				Time series for every alertable metric. Dashed lines are your alert
				thresholds — a metric turns red while one of its rules is firing.
			</p>

			{/* Global metrics (LB, cost cluster, health) */}
			<div className="grid gap-4 md:grid-cols-2">
				{globalMetrics.map((m) => (
					<MetricChart
						key={m.metric}
						meta={m}
						target={null}
						minutes={minutes}
						rules={allRules}
					/>
				))}
			</div>

			{/* Per-service */}
			{serviceMetrics.length > 0 && (
				<Card className="bg-background">
					<CardHeader className="pb-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<CardTitle className="text-lg">Per service</CardTitle>
							<Select
								value={serviceTarget ?? ""}
								onValueChange={(v) => setServiceTarget(v)}
							>
								<SelectTrigger className="w-64">
									<SelectValue placeholder="Pick a service…" />
								</SelectTrigger>
								<SelectContent>
									{(services ?? []).map((s) => (
										<SelectItem key={s.appName} value={s.appName}>
											{s.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</CardHeader>
					<CardContent>
						{serviceTarget ? (
							<div className="grid gap-4 md:grid-cols-2">
								{serviceMetrics.map((m) => (
									<MetricChart
										key={m.metric}
										meta={m}
										target={serviceTarget}
										minutes={minutes}
										rules={allRules}
									/>
								))}
							</div>
						) : (
							<p className="py-6 text-center text-sm text-muted-foreground">
								Pick a service to see its CPU / memory.
							</p>
						)}
					</CardContent>
				</Card>
			)}

			{/* Per-project cost */}
			{projectCostMetric && (
				<Card className="bg-background">
					<CardHeader className="pb-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<CardTitle className="text-lg">Per-project cost</CardTitle>
							<Select
								value={projectTarget ?? ""}
								onValueChange={(v) => setProjectTarget(v)}
							>
								<SelectTrigger className="w-64">
									<SelectValue placeholder="Pick a project…" />
								</SelectTrigger>
								<SelectContent>
									{(projects ?? []).map((p) => (
										<SelectItem key={p.projectId} value={p.projectId}>
											{p.projectName}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</CardHeader>
					<CardContent>
						{projectTarget ? (
							<MetricChart
								meta={projectCostMetric}
								target={projectTarget}
								minutes={minutes}
								rules={allRules}
							/>
						) : (
							<p className="py-6 text-center text-sm text-muted-foreground">
								Pick a project to see its run-rate.
							</p>
						)}
					</CardContent>
				</Card>
			)}
		</div>
	);
};
