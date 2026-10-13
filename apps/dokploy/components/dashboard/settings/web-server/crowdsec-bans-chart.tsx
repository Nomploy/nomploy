import { format } from "date-fns";
import { ShieldBan } from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import { api } from "@/utils/api";

const config = {
	bans: { label: "Active bans", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

/**
 * Active-ban count over time, from the server-side sampler (one point/min). The
 * series is global (CrowdSec is cluster-wide). Shown on the Security page above
 * the decisions table.
 */
export const CrowdsecBansChart = () => {
	const { data } = api.settings.getCrowdsecBanHistory.useQuery(
		{ minutes: 360 },
		{ refetchInterval: 30000 },
	);
	const points = (data ?? []).map((p) => ({ time: p.ts, bans: p.bans }));

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<ShieldBan className="size-4 text-muted-foreground" />
				<span className="text-base font-medium">Active bans (last 6h)</span>
			</div>
			{points.length < 2 ? (
				<p className="py-6 text-center text-muted-foreground text-sm">
					Collecting samples… (one per minute)
				</p>
			) : (
				<ChartContainer config={config} className="h-[180px] w-full">
					<AreaChart data={points} margin={{ left: 4, right: 8, top: 8 }}>
						<CartesianGrid vertical={false} />
						<XAxis
							dataKey="time"
							tickFormatter={(t) => format(new Date(t), "HH:mm")}
							tickLine={false}
							axisLine={false}
							minTickGap={40}
						/>
						<YAxis
							tickLine={false}
							axisLine={false}
							width={32}
							allowDecimals={false}
						/>
						<ChartTooltip content={<ChartTooltipContent />} />
						<Area
							dataKey="bans"
							type="monotone"
							stroke="var(--color-bans)"
							fill="var(--color-bans)"
							fillOpacity={0.15}
							isAnimationActive={false}
						/>
					</AreaChart>
				</ChartContainer>
			)}
		</div>
	);
};
