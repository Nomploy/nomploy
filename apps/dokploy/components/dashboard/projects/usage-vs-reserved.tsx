import { Cpu, MemoryStick } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type ServiceMetrics = {
	cpuUsedMhz: number;
	cpuAllocMhz: number;
	memUsedMb: number;
	memAllocMb: number;
};

const pct = (used: number, reserved: number) =>
	reserved > 0 ? Math.min(100, Math.round((used / reserved) * 100)) : 0;

const fmtMhz = (mhz: number) =>
	mhz >= 1000 ? `${(mhz / 1000).toFixed(1)} GHz` : `${mhz} MHz`;
const fmtMb = (mb: number) =>
	mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

/** One used-vs-reserved bar: reserved is the track, used is the fill. */
const Bar = ({
	used,
	reserved,
	color,
}: {
	used: number;
	reserved: number;
	color: string;
}) => {
	const p = pct(used, reserved);
	// Over-reserved (a brief spike above the request) reads red.
	const over = reserved > 0 && used > reserved;
	return (
		<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
			<div
				className={cn("h-full rounded-full", over && "!bg-destructive")}
				style={{ width: `${p}%`, backgroundColor: over ? undefined : color }}
			/>
		</div>
	);
};

/**
 * Compact CPU + memory used-vs-reserved bars for a service card. Renders nothing
 * when the service has no reserved resources reported (not scheduled / no
 * telemetry yet).
 */
export const MiniUsage = ({ metrics }: { metrics?: ServiceMetrics }) => {
	if (!metrics) return null;
	const { cpuUsedMhz, cpuAllocMhz, memUsedMb, memAllocMb } = metrics;
	if (cpuAllocMhz <= 0 && memAllocMb <= 0) return null;
	return (
		<div className="mb-2 flex flex-col gap-1.5">
			<div className="flex flex-col gap-0.5">
				<div className="flex items-center justify-between text-[11px] text-muted-foreground">
					<span className="flex items-center gap-1">
						<Cpu className="size-3" /> CPU
					</span>
					<span>
						{cpuUsedMhz}/{fmtMhz(cpuAllocMhz)} · {pct(cpuUsedMhz, cpuAllocMhz)}%
					</span>
				</div>
				<Bar
					used={cpuUsedMhz}
					reserved={cpuAllocMhz}
					color="hsl(var(--chart-1))"
				/>
			</div>
			<div className="flex flex-col gap-0.5">
				<div className="flex items-center justify-between text-[11px] text-muted-foreground">
					<span className="flex items-center gap-1">
						<MemoryStick className="size-3" /> Mem
					</span>
					<span>
						{fmtMb(memUsedMb)}/{fmtMb(memAllocMb)} ·{" "}
						{pct(memUsedMb, memAllocMb)}%
					</span>
				</div>
				<Bar
					used={memUsedMb}
					reserved={memAllocMb}
					color="hsl(var(--chart-2))"
				/>
			</div>
		</div>
	);
};

/**
 * Environment-wide used-vs-reserved summary card (sum across the environment's
 * services). Shown above the services grid.
 */
export const EnvResourceUsage = ({ totals }: { totals?: ServiceMetrics }) => {
	if (!totals) return null;
	const { cpuUsedMhz, cpuAllocMhz, memUsedMb, memAllocMb } = totals;
	if (cpuAllocMhz <= 0 && memAllocMb <= 0) return null;
	return (
		<Card className="bg-background">
			<CardHeader className="pb-3">
				<CardTitle className="text-sm font-medium text-muted-foreground">
					Resource usage — used vs reserved (live)
				</CardTitle>
			</CardHeader>
			<CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between text-sm">
						<span className="flex items-center gap-1.5 font-medium">
							<Cpu className="size-4" /> CPU
						</span>
						<span className="text-muted-foreground">
							{fmtMhz(cpuUsedMhz)} / {fmtMhz(cpuAllocMhz)} ·{" "}
							{pct(cpuUsedMhz, cpuAllocMhz)}%
						</span>
					</div>
					<Bar
						used={cpuUsedMhz}
						reserved={cpuAllocMhz}
						color="hsl(var(--chart-1))"
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between text-sm">
						<span className="flex items-center gap-1.5 font-medium">
							<MemoryStick className="size-4" /> Memory
						</span>
						<span className="text-muted-foreground">
							{fmtMb(memUsedMb)} / {fmtMb(memAllocMb)} ·{" "}
							{pct(memUsedMb, memAllocMb)}%
						</span>
					</div>
					<Bar
						used={memUsedMb}
						reserved={memAllocMb}
						color="hsl(var(--chart-2))"
					/>
				</div>
			</CardContent>
		</Card>
	);
};
