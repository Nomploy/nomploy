import { format } from "date-fns";
import { LineChartIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
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

interface Props {
	appName: string;
	serverId?: string;
}

type Point = { time: number; cpu: number; mem: number };
const MAX_POINTS = 60; // ~5 min at a 5s poll

const config = {
	cpu: { label: "CPU %", color: "hsl(var(--chart-1))" },
	mem: { label: "Memory (MB)", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig;

/**
 * Live resource graph for a Nomad service, from telemetry
 * (publish_allocation_metrics). Polls getServiceMetrics every 5s and keeps a rolling
 * window — no history before the page was opened (there's no metrics TSDB). Sums
 * cpu%/memory across the service's task groups.
 */
export const ServiceMetricsGraph = ({ appName, serverId }: Props) => {
	const { data } = api.nomad.getServiceMetrics.useQuery(
		{ jobId: appName, serverId },
		{ enabled: !!appName, refetchInterval: 5000 },
	);
	const [points, setPoints] = useState<Point[]>([]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: append on each poll (ts)
	useEffect(() => {
		if (!data) return;
		const cpu = data.groups.reduce((s, g) => s + g.cpuPercent, 0);
		const mem = data.groups.reduce((s, g) => s + g.memoryMb, 0);
		setPoints((prev) =>
			[...prev, { time: data.ts, cpu: Math.round(cpu * 10) / 10, mem }].slice(
				-MAX_POINTS,
			),
		);
	}, [data?.ts]);

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<LineChartIcon className="size-4" /> Resource usage (live)
				</CardTitle>
				<CardDescription>
					CPU % and memory summed across the service's task groups, from Nomad
					telemetry. Live only — a rolling ~5-minute window.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{points.length < 2 ? (
					<p className="py-8 text-center text-muted-foreground text-sm">
						Collecting metrics…
					</p>
				) : (
					<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
						<ChartContainer config={config} className="h-[200px] w-full">
							<LineChart data={points} margin={{ left: 4, right: 8, top: 8 }}>
								<CartesianGrid vertical={false} />
								<XAxis
									dataKey="time"
									tickFormatter={(t) => format(new Date(t), "HH:mm:ss")}
									tickLine={false}
									axisLine={false}
									minTickGap={40}
								/>
								<YAxis tickLine={false} axisLine={false} width={36} />
								<ChartTooltip content={<ChartTooltipContent />} />
								<Line
									dataKey="cpu"
									type="monotone"
									stroke="var(--color-cpu)"
									dot={false}
									isAnimationActive={false}
								/>
							</LineChart>
						</ChartContainer>
						<ChartContainer config={config} className="h-[200px] w-full">
							<LineChart data={points} margin={{ left: 4, right: 8, top: 8 }}>
								<CartesianGrid vertical={false} />
								<XAxis
									dataKey="time"
									tickFormatter={(t) => format(new Date(t), "HH:mm:ss")}
									tickLine={false}
									axisLine={false}
									minTickGap={40}
								/>
								<YAxis tickLine={false} axisLine={false} width={44} />
								<ChartTooltip content={<ChartTooltipContent />} />
								<Line
									dataKey="mem"
									type="monotone"
									stroke="var(--color-mem)"
									dot={false}
									isAnimationActive={false}
								/>
							</LineChart>
						</ChartContainer>
					</div>
				)}
			</CardContent>
		</Card>
	);
};
