import { format } from "date-fns";
import { BarChart3 } from "lucide-react";
import { useState } from "react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ReferenceLine,
	XAxis,
	YAxis,
} from "recharts";
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
import { buildSeries, clipSeries, type Ev } from "./autoscaling-series";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Time windows for the instances-over-time charts. `null` = all reconstructed
// history (no clipping).
const RANGES: { label: string; ms: number | null }[] = [
	{ label: "1h", ms: HOUR },
	{ label: "6h", ms: 6 * HOUR },
	{ label: "24h", ms: DAY },
	{ label: "7d", ms: 7 * DAY },
	{ label: "30d", ms: 30 * DAY },
	{ label: "All", ms: null },
];

// tRPC inference for these nomad procedures degrades to `{}` (known quirk), so
// cast to exactly what we read.
interface GroupStatus {
	groupId: string;
	name: string;
	decision?: { workerCount?: number } | null;
	nodes?: unknown[];
}
interface GroupConfig {
	groupId: string;
	name: string;
	enabled: boolean;
	minNodes: number;
	maxNodes: number;
}
const chartConfig = {
	count: { label: "Running", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

export const ShowAutoscalingGraphs = () => {
	const { data: statusRaw } = api.nomad.getAutoscalerStatus.useQuery(
		undefined,
		{
			refetchInterval: 30000,
		},
	);
	const { data: groupsRaw } = api.nomad.listAutoscalingGroups.useQuery();
	// Graphs plot count-over-time, so fetch a wide window of history (not the
	// paginated 10 the Activity feed uses). Capped at 500 server-side.
	const { data: eventsRaw } = api.nomad.getAutoscalerEvents.useQuery(
		{ limit: 500 },
		{
			refetchInterval: 30000,
		},
	);

	const [rangeLabel, setRangeLabel] = useState("7d");
	const rangeMs = RANGES.find((r) => r.label === rangeLabel)?.ms ?? null;
	const now = Date.now();
	// `null` for "All" — the effective left bound is then derived per group from
	// its own oldest reconstructed point (see below).
	const from = rangeMs === null ? null : now - rangeMs;

	const status = (statusRaw ?? []) as GroupStatus[];
	const groups = (groupsRaw ?? []) as GroupConfig[];
	const events = (eventsRaw?.events ?? []) as Ev[];

	const enabled = groups.filter((g) => g.enabled);
	if (enabled.length === 0) return null;

	return (
		<Card className="bg-background">
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="space-y-1.5">
						<CardTitle className="flex items-center gap-2 text-xl">
							<BarChart3 className="size-5" />
							Autoscaling — instances over time
						</CardTitle>
						<CardDescription>
							Running nodes per autoscaling group, reconstructed from scale
							activity, against each group's min/max bounds.
						</CardDescription>
					</div>
					<Select value={rangeLabel} onValueChange={setRangeLabel}>
						<SelectTrigger className="w-24" aria-label="Time range">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{RANGES.map((r) => (
								<SelectItem key={r.label} value={r.label}>
									{r.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</CardHeader>
			<CardContent className="grid gap-6 lg:grid-cols-2">
				{enabled.map((g) => {
					const st = status.find((s) => s.groupId === g.groupId);
					const current = st?.decision?.workerCount ?? st?.nodes?.length ?? 0;
					const raw = buildSeries(
						current,
						events.filter((e) => e.groupId === g.groupId),
					);
					// "All" spans from this group's oldest reconstructed point; clamp to a
					// ≥1h window so a group with no scale history still renders a baseline
					// instead of collapsing to a single dot.
					const effFrom = from ?? Math.min(raw[0]?.t ?? now, now - HOUR);
					const series = clipSeries(raw, effFrom, now);
					// <=24h windows read as clock times; longer windows as calendar days.
					const fmt = now - effFrom <= DAY ? "HH:mm" : "MMM d";
					// Headroom above max so the max line isn't clipped at the top.
					const yMax = Math.max(g.maxNodes, current) + 1;
					return (
						<div key={g.groupId} className="space-y-2">
							<div className="flex items-baseline justify-between">
								<span className="font-medium">{g.name}</span>
								<span className="text-sm text-muted-foreground tabular-nums">
									{current} running · min {g.minNodes} · max {g.maxNodes}
								</span>
							</div>
							<ChartContainer config={chartConfig} className="h-[9rem] w-full">
								<LineChart
									data={series}
									margin={{ top: 6, right: 8, left: 0, bottom: 0 }}
								>
									<CartesianGrid vertical={false} />
									<XAxis
										dataKey="t"
										type="number"
										scale="time"
										domain={[effFrom, now]}
										tickLine={false}
										axisLine={false}
										tickMargin={8}
										minTickGap={40}
										tickFormatter={(v) => format(new Date(v), fmt)}
									/>
									<YAxis
										tickLine={false}
										axisLine={false}
										width={24}
										allowDecimals={false}
										domain={[0, yMax]}
									/>
									<ReferenceLine
										y={g.maxNodes}
										stroke="hsl(var(--muted-foreground))"
										strokeDasharray="4 4"
										label={{
											value: "max",
											position: "insideTopRight",
											fontSize: 10,
											fill: "hsl(var(--muted-foreground))",
										}}
									/>
									{g.minNodes > 0 && (
										<ReferenceLine
											y={g.minNodes}
											stroke="hsl(var(--muted-foreground))"
											strokeDasharray="4 4"
											label={{
												value: "min",
												position: "insideBottomRight",
												fontSize: 10,
												fill: "hsl(var(--muted-foreground))",
											}}
										/>
									)}
									<ChartTooltip
										cursor={false}
										content={
											<ChartTooltipContent
												labelFormatter={(_, payload) => {
													const t = payload?.[0]?.payload?.t;
													return t ? format(new Date(t), "PPpp") : "";
												}}
												formatter={(value) => [`${value} nodes`, "Running"]}
											/>
										}
									/>
									<Line
										type="stepAfter"
										dataKey="count"
										stroke="var(--color-count)"
										strokeWidth={2}
										dot={false}
									/>
								</LineChart>
							</ChartContainer>
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
};
