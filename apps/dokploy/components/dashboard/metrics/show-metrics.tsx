import { format } from "date-fns";
import { BellPlus, ZoomOut } from "lucide-react";
import { useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ReferenceArea,
	ReferenceLine,
	XAxis,
	YAxis,
} from "recharts";
import { RuleDialog } from "@/components/dashboard/monitoring/show-alerts";
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
	{ label: "7d", minutes: 10080 },
	{ label: "30d", minutes: 43200 },
];

const SERIES_COLORS = [
	"hsl(var(--chart-1))",
	"hsl(var(--chart-2))",
	"hsl(var(--chart-3))",
	"hsl(var(--chart-4))",
	"hsl(var(--chart-5))",
];

const fmtValue = (v: number, unit: string) => {
	const n = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
	return unit === "€/mo" ? `${n} €/mo` : `${n} ${unit}`;
};

const tickFmt = (minutes: number) => (t: number) =>
	format(new Date(t), minutes > 1440 ? "MM/dd" : "HH:mm");

/** Drag-to-zoom state for a chart's time (x) axis. */
const useZoom = () => {
	const [refL, setRefL] = useState<number | null>(null);
	const [refR, setRefR] = useState<number | null>(null);
	const [domain, setDomain] = useState<[number, number] | null>(null);
	const onDown = (e: { activeLabel?: string | number }) => {
		if (e?.activeLabel != null) setRefL(Number(e.activeLabel));
	};
	const onMove = (e: { activeLabel?: string | number }) => {
		if (refL != null && e?.activeLabel != null) setRefR(Number(e.activeLabel));
	};
	const onUp = () => {
		if (refL != null && refR != null && refL !== refR) {
			setDomain([Math.min(refL, refR), Math.max(refL, refR)]);
		}
		setRefL(null);
		setRefR(null);
	};
	return {
		refL,
		refR,
		domain,
		reset: () => setDomain(null),
		handlers: { onMouseDown: onDown, onMouseMove: onMove, onMouseUp: onUp },
	};
};

const CreateAlertButton = ({
	metric,
	target,
	onDone,
}: {
	metric: string;
	target?: string | null;
	onDone: () => void;
}) => (
	<RuleDialog
		preset={{ metric, target }}
		onDone={onDone}
		trigger={
			<Button type="button" variant="ghost" size="sm" className="h-7 px-2">
				<BellPlus className="mr-1 size-3.5" />
				Alert
			</Button>
		}
	/>
);

const ChartHeader = ({
	title,
	value,
	firing,
	rulesText,
	metric,
	target,
	onRuleDone,
	zoomed,
	onReset,
}: {
	title: string;
	value?: string;
	firing: boolean;
	rulesText?: string;
	metric: string;
	target?: string | null;
	onRuleDone: () => void;
	zoomed: boolean;
	onReset: () => void;
}) => (
	<CardHeader className="pb-2">
		<div className="flex items-center justify-between gap-2">
			<CardTitle className="text-base">{title}</CardTitle>
			<div className="flex items-center gap-1">
				{value != null && (
					<span
						className={`text-sm font-medium ${firing ? "text-destructive" : "text-muted-foreground"}`}
					>
						{value}
					</span>
				)}
				{zoomed && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 px-2"
						onClick={onReset}
					>
						<ZoomOut className="size-3.5" />
					</Button>
				)}
				<CreateAlertButton
					metric={metric}
					target={target}
					onDone={onRuleDone}
				/>
			</div>
		</div>
		{rulesText && <CardDescription>{rulesText}</CardDescription>}
	</CardHeader>
);

const EventMarkers = ({
	metric,
	target,
	minutes,
}: {
	metric: string;
	target: string | null;
	minutes: number;
}) => {
	const { data } = api.alert.eventMarkers.useQuery(
		{ metric, target, minutes },
		{ refetchInterval: 60000 },
	);
	return (
		<>
			{(data ?? []).map((m, i) => (
				<ReferenceLine
					key={`${m.ts}-${i}`}
					x={m.ts}
					stroke={
						m.type === "fired"
							? "hsl(var(--destructive))"
							: "hsl(var(--muted-foreground))"
					}
					strokeOpacity={0.5}
				/>
			))}
		</>
	);
};

const single = {
	value: { label: "value", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

/** Single-series chart: global metrics, per-project cost. */
const MetricChart = ({
	meta,
	target,
	minutes,
	rules,
	onRuleDone,
}: {
	meta: MetricMeta;
	target: string | null;
	minutes: number;
	rules: Rule[];
	onRuleDone: () => void;
}) => {
	const zoom = useZoom();
	const { data } = api.alert.metricHistory.useQuery(
		{ metric: meta.metric, target, minutes },
		{ refetchInterval: 30000 },
	);
	const points = (data?.points ?? []).map((p) => ({
		time: p.ts,
		value: p.value,
	}));
	const latest = points.at(-1)?.value;
	const myRules = rules.filter(
		(r) =>
			r.metric === meta.metric &&
			(meta.needsTarget ? r.target === target : true),
	);
	const firing = myRules.some((r) => r.state === "firing");

	return (
		<Card className="bg-background">
			<ChartHeader
				title={meta.label}
				value={latest != null ? fmtValue(latest, meta.unit) : "—"}
				firing={firing}
				rulesText={
					myRules.length
						? myRules
								.map(
									(r) =>
										`${r.name}: ${r.comparator === "gt" ? ">" : "<"} ${fmtValue(r.threshold, meta.unit)}`,
								)
								.join(" · ")
						: undefined
				}
				metric={meta.metric}
				target={target}
				onRuleDone={onRuleDone}
				zoomed={!!zoom.domain}
				onReset={zoom.reset}
			/>
			<CardContent>
				{points.length < 2 ? (
					<p className="py-10 text-center text-sm text-muted-foreground">
						Collecting samples…
					</p>
				) : (
					<ChartContainer config={single} className="h-[180px] w-full">
						<AreaChart
							data={points}
							margin={{ left: 4, right: 8, top: 8 }}
							{...zoom.handlers}
						>
							<CartesianGrid vertical={false} />
							<XAxis
								dataKey="time"
								type="number"
								scale="time"
								domain={zoom.domain ?? ["dataMin", "dataMax"]}
								allowDataOverflow
								tickFormatter={tickFmt(minutes)}
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
							<EventMarkers
								metric={meta.metric}
								target={target}
								minutes={minutes}
							/>
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
							{zoom.refL != null && zoom.refR != null && (
								<ReferenceArea
									x1={zoom.refL}
									x2={zoom.refR}
									strokeOpacity={0.3}
								/>
							)}
						</AreaChart>
					</ChartContainer>
				)}
			</CardContent>
		</Card>
	);
};

/** Multi-series chart: every service on one chart (service_ metrics). */
const MultiServiceChart = ({
	meta,
	minutes,
	rules,
	onRuleDone,
}: {
	meta: MetricMeta;
	minutes: number;
	rules: Rule[];
	onRuleDone: () => void;
}) => {
	const zoom = useZoom();
	const { data } = api.alert.serviceSeriesAll.useQuery(
		{ metric: meta.metric, minutes },
		{ refetchInterval: 30000 },
	);
	const series = data ?? [];
	// Merge per-service series into rows keyed by timestamp.
	const byTs = new Map<number, Record<string, number>>();
	for (const s of series)
		for (const p of s.points) {
			const row = byTs.get(p.ts) ?? {};
			row[s.appName] = p.value;
			byTs.set(p.ts, row);
		}
	const rows = [...byTs.entries()]
		.map(([time, vals]) => ({ time, ...vals }))
		.sort((a, b) => a.time - b.time);
	// "All services" + specific thresholds on this metric.
	const myRules = rules.filter((r) => r.metric === meta.metric);
	const firing = myRules.some((r) => r.state === "firing");
	const cfg: ChartConfig = Object.fromEntries(
		series.map((s, i) => [
			s.appName,
			{ label: s.label, color: SERIES_COLORS[i % SERIES_COLORS.length] },
		]),
	);

	return (
		<Card className="bg-background">
			<ChartHeader
				title={meta.label}
				firing={firing}
				rulesText={
					myRules.length
						? myRules
								.map(
									(r) =>
										`${r.name}: ${r.comparator === "gt" ? ">" : "<"} ${fmtValue(r.threshold, meta.unit)}`,
								)
								.join(" · ")
						: undefined
				}
				metric={meta.metric}
				target={null}
				onRuleDone={onRuleDone}
				zoomed={!!zoom.domain}
				onReset={zoom.reset}
			/>
			<CardContent>
				{rows.length < 2 ? (
					<p className="py-10 text-center text-sm text-muted-foreground">
						Collecting samples…
					</p>
				) : (
					<ChartContainer config={cfg} className="h-[220px] w-full">
						<LineChart
							data={rows}
							margin={{ left: 4, right: 8, top: 8 }}
							{...zoom.handlers}
						>
							<CartesianGrid vertical={false} />
							<XAxis
								dataKey="time"
								type="number"
								scale="time"
								domain={zoom.domain ?? ["dataMin", "dataMax"]}
								allowDataOverflow
								tickFormatter={tickFmt(minutes)}
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
							<Legend />
							{myRules.map((r) => (
								<ReferenceLine
									key={r.alertRuleId}
									y={r.threshold}
									stroke="hsl(var(--destructive))"
									strokeDasharray="4 4"
									strokeOpacity={0.7}
								/>
							))}
							{series.map((s, i) => (
								<Line
									key={s.appName}
									dataKey={s.appName}
									name={s.label}
									type="monotone"
									stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
									dot={false}
									connectNulls
									isAnimationActive={false}
								/>
							))}
							{zoom.refL != null && zoom.refR != null && (
								<ReferenceArea
									x1={zoom.refL}
									x2={zoom.refR}
									strokeOpacity={0.3}
								/>
							)}
						</LineChart>
					</ChartContainer>
				)}
			</CardContent>
		</Card>
	);
};

const costCfg = {
	allocated: { label: "Services", color: "hsl(var(--chart-1))" },
	platform: { label: "Platform", color: "hsl(var(--chart-4))" },
	idle: { label: "Idle", color: "hsl(var(--muted-foreground))" },
} satisfies ChartConfig;

/** Cluster cost as a stacked area (services / platform / idle), with threshold. */
const CostClusterChart = ({
	minutes,
	rules,
	onRuleDone,
}: {
	minutes: number;
	rules: Rule[];
	onRuleDone: () => void;
}) => {
	const zoom = useZoom();
	const { data } = api.cost.history.useQuery(
		{ minutes },
		{ refetchInterval: 60000 },
	);
	const rows = (data ?? []).map((p) => ({
		time: p.ts,
		allocated: p.allocated,
		platform: p.platform,
		idle: p.idle,
		total: p.total,
	}));
	const latest = rows.at(-1)?.total;
	const myRules = rules.filter((r) => r.metric === "cost_cluster_monthly");
	const firing = myRules.some((r) => r.state === "firing");

	return (
		<Card className="bg-background">
			<ChartHeader
				title="Cost — cluster run-rate"
				value={latest != null ? fmtValue(latest, "€/mo") : "—"}
				firing={firing}
				rulesText={
					myRules.length
						? myRules
								.map(
									(r) =>
										`${r.name}: ${r.comparator === "gt" ? ">" : "<"} ${fmtValue(r.threshold, "€/mo")}`,
								)
								.join(" · ")
						: undefined
				}
				metric="cost_cluster_monthly"
				target={null}
				onRuleDone={onRuleDone}
				zoomed={!!zoom.domain}
				onReset={zoom.reset}
			/>
			<CardContent>
				{rows.length < 2 ? (
					<p className="py-10 text-center text-sm text-muted-foreground">
						Collecting samples…
					</p>
				) : (
					<ChartContainer config={costCfg} className="h-[200px] w-full">
						<AreaChart
							data={rows}
							margin={{ left: 4, right: 8, top: 8 }}
							{...zoom.handlers}
						>
							<CartesianGrid vertical={false} />
							<XAxis
								dataKey="time"
								type="number"
								scale="time"
								domain={zoom.domain ?? ["dataMin", "dataMax"]}
								allowDataOverflow
								tickFormatter={tickFmt(minutes)}
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
							<Legend />
							{myRules.map((r) => (
								<ReferenceLine
									key={r.alertRuleId}
									y={r.threshold}
									stroke="hsl(var(--destructive))"
									strokeDasharray="4 4"
									strokeOpacity={0.7}
								/>
							))}
							{(["allocated", "platform", "idle"] as const).map((k) => (
								<Area
									key={k}
									dataKey={k}
									stackId="c"
									name={costCfg[k].label}
									type="monotone"
									stroke={`var(--color-${k})`}
									fill={`var(--color-${k})`}
									fillOpacity={0.3}
									isAnimationActive={false}
								/>
							))}
							{zoom.refL != null && zoom.refR != null && (
								<ReferenceArea
									x1={zoom.refL}
									x2={zoom.refR}
									strokeOpacity={0.3}
								/>
							)}
						</AreaChart>
					</ChartContainer>
				)}
			</CardContent>
		</Card>
	);
};

export const ShowMetrics = () => {
	const [minutes, setMinutes] = useState(360);
	const [projectTarget, setProjectTarget] = useState<string | null>(null);

	const { data: metrics } = api.alert.metrics.useQuery();
	const { data: rules, refetch: refetchRules } = api.alert.list.useQuery();
	const { data: projects } = api.cost.projectTargets.useQuery();
	const onRuleDone = () => refetchRules();

	const allRules = (rules ?? []) as unknown as Rule[];
	const metas = (metrics ?? []) as MetricMeta[];
	const lbMetrics = metas.filter((m) => m.metric.startsWith("lb_"));
	const healthMetrics = metas.filter(
		(m) =>
			!m.needsTarget &&
			!m.metric.startsWith("lb_") &&
			!m.metric.startsWith("cost_"),
	);
	const serviceMetrics = metas.filter((m) => m.metric.startsWith("service_"));
	const hasProjectCost = metas.some((m) => m.metric === "cost_project_monthly");

	return (
		<div className="flex w-full flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm text-muted-foreground">
					Drag across a chart to zoom. Dashed lines are your alert thresholds;
					vertical marks are fired/resolved events. Use “Alert” to add a rule.
				</p>
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

			{/* Cost + LB + health */}
			<div className="grid gap-4 md:grid-cols-2">
				<CostClusterChart
					minutes={minutes}
					rules={allRules}
					onRuleDone={onRuleDone}
				/>
				{lbMetrics.map((m) => (
					<MetricChart
						key={m.metric}
						meta={m}
						target={null}
						minutes={minutes}
						rules={allRules}
						onRuleDone={onRuleDone}
					/>
				))}
				{healthMetrics.map((m) => (
					<MetricChart
						key={m.metric}
						meta={m}
						target={null}
						minutes={minutes}
						rules={allRules}
						onRuleDone={onRuleDone}
					/>
				))}
			</div>

			{/* Per-service multi-line */}
			{serviceMetrics.map((m) => (
				<MultiServiceChart
					key={m.metric}
					meta={m}
					minutes={minutes}
					rules={allRules}
					onRuleDone={onRuleDone}
				/>
			))}

			{/* Per-project cost */}
			{hasProjectCost && (
				<Card className="bg-background">
					<CardHeader className="pb-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<CardTitle className="text-lg">Per-project cost</CardTitle>
							<select
								className="h-9 rounded-md border bg-background px-2 text-sm"
								value={projectTarget ?? ""}
								onChange={(e) => setProjectTarget(e.target.value || null)}
							>
								<option value="">Pick a project…</option>
								{(projects ?? []).map((p) => (
									<option key={p.projectId} value={p.projectId}>
										{p.projectName}
									</option>
								))}
							</select>
						</div>
					</CardHeader>
					<CardContent>
						{projectTarget ? (
							<MetricChart
								meta={{
									metric: "cost_project_monthly",
									label: "Project run-rate",
									unit: "€/mo",
									needsTarget: true,
								}}
								target={projectTarget}
								minutes={minutes}
								rules={allRules}
								onRuleDone={onRuleDone}
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
