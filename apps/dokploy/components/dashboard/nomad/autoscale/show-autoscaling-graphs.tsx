import { format } from "date-fns";
import { BarChart3 } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, YAxis } from "recharts";
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
interface Ev {
	type: string;
	createdAt: string;
	groupId?: string | null;
}

const chartConfig = {
	count: { label: "Running", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

/**
 * Reconstruct a group's running-node count over time from the autoscaler event
 * log. recordEvent is the single chokepoint for every scale action, so walking
 * the scale_up/scale_down events backward from the current count yields an
 * accurate step timeline — no separate time-series store needed. (Manual/
 * provider-side changes outside the autoscaler aren't captured; a sampled series
 * is the more robust follow-up.)
 */
const buildSeries = (
	currentCount: number,
	events: Ev[], // newest-first, already filtered to this group
): Array<{ t: number; count: number }> => {
	const scale = events.filter(
		(e) => e.type === "scale_up" || e.type === "scale_down",
	);
	let count = currentCount;
	const pts: Array<{ t: number; count: number }> = [{ t: Date.now(), count }];
	for (const e of scale) {
		const t = new Date(e.createdAt).getTime();
		pts.push({ t, count: Math.max(0, count) });
		// Value before this event (older interval).
		count = e.type === "scale_up" ? count - 1 : count + 1;
	}
	if (scale.length > 0) {
		const oldest = new Date(scale[scale.length - 1]!.createdAt).getTime();
		pts.push({ t: oldest - 1000, count: Math.max(0, count) });
	}
	return pts.sort((a, b) => a.t - b.t);
};

export const ShowAutoscalingGraphs = () => {
	const { data: statusRaw } = api.nomad.getAutoscalerStatus.useQuery(
		undefined,
		{
			refetchInterval: 30000,
		},
	);
	const { data: groupsRaw } = api.nomad.listAutoscalingGroups.useQuery();
	const { data: eventsRaw } = api.nomad.getAutoscalerEvents.useQuery(
		undefined,
		{
			refetchInterval: 30000,
		},
	);

	const status = (statusRaw ?? []) as GroupStatus[];
	const groups = (groupsRaw ?? []) as GroupConfig[];
	const events = (eventsRaw ?? []) as Ev[];

	const enabled = groups.filter((g) => g.enabled);
	if (enabled.length === 0) return null;

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<BarChart3 className="size-5" />
					Autoscaling — instances over time
				</CardTitle>
				<CardDescription>
					Running nodes per autoscaling group, reconstructed from scale
					activity, against each group's min/max bounds.
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-6 lg:grid-cols-2">
				{enabled.map((g) => {
					const st = status.find((s) => s.groupId === g.groupId);
					const current = st?.decision?.workerCount ?? st?.nodes?.length ?? 0;
					const series = buildSeries(
						current,
						events.filter((e) => e.groupId === g.groupId),
					);
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
