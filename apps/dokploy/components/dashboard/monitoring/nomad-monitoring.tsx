import { Activity, Boxes, Cpu, MemoryStick, Server } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

const fmtMb = (v: number) =>
	v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`;
const fmtMhz = (v: number) =>
	v >= 1000 ? `${(v / 1000).toFixed(1)} GHz` : `${Math.round(v)} MHz`;
const pct = (used: number, total: number) =>
	total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;

// A stacked utilization bar: reserved (scheduled) as a filled band, live-used as
// a darker overlay, against total capacity. Color by how full it is.
const UtilBar = ({
	used,
	reserved,
	total,
}: {
	used: number; // live usage (same unit as total), may be 0/unknown
	reserved: number; // scheduled/allocated
	total: number; // capacity
}) => {
	const rPct = pct(reserved, total);
	const uPct = pct(used, total);
	const hot =
		rPct >= 90
			? "bg-destructive"
			: rPct >= 70
				? "bg-amber-500"
				: "bg-emerald-500";
	return (
		<div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
			{/* reserved band (lighter) */}
			<div
				className={`absolute inset-y-0 left-0 ${hot} opacity-30`}
				style={{ width: `${rPct}%` }}
			/>
			{/* live used (solid) */}
			<div
				className={`absolute inset-y-0 left-0 ${hot}`}
				style={{ width: `${uPct}%` }}
			/>
		</div>
	);
};

const Tile = ({
	icon,
	label,
	value,
	sub,
}: {
	icon: React.ReactNode;
	label: string;
	value: string;
	sub?: string;
}) => (
	<Card className="bg-background">
		<CardContent className="flex items-center gap-3 p-4">
			<div className="text-muted-foreground">{icon}</div>
			<div className="flex flex-col">
				<span className="text-muted-foreground text-xs">{label}</span>
				<span className="font-semibold text-lg leading-tight">{value}</span>
				{sub && <span className="text-muted-foreground text-xs">{sub}</span>}
			</div>
		</CardContent>
	</Card>
);

/**
 * Nomad cluster monitoring — the observability view (distinct from /dashboard/nomad,
 * which manages the cluster). Merges per-node capacity+reserved (getNodesWithResources)
 * with live host usage (getClusterMetrics), plus top projects by usage
 * (getProjectsMetrics). Polls; degrades gracefully when Nomad is unreachable.
 */
export const NomadMonitoring = () => {
	const { data: nodes, isPending } = api.nomad.getNodesWithResources.useQuery(
		{},
		{ refetchInterval: 15000 },
	);
	const { data: live } = api.nomad.getClusterMetrics.useQuery(
		{},
		{ refetchInterval: 15000 },
	);
	const { data: projectMetrics } = api.nomad.getProjectsMetrics.useQuery(
		undefined,
		{ refetchInterval: 15000 },
	);
	const { data: projects } = api.project.all.useQuery();

	const liveByNode = useMemo(
		() => new Map((live ?? []).map((n) => [n.nodeId, n])),
		[live],
	);
	const projectName = useMemo(
		() => new Map((projects ?? []).map((p) => [p.projectId, p.name])),
		[projects],
	);

	const totals = useMemo(() => {
		const t = {
			nodes: 0,
			ready: 0,
			allocs: 0,
			cpuCap: 0,
			cpuRes: 0,
			memCap: 0,
			memRes: 0,
			memUsed: 0,
		};
		for (const n of nodes ?? []) {
			t.nodes++;
			if (n.Status === "ready") t.ready++;
			t.allocs += n.allocCount;
			t.cpuCap += n.cpu.total;
			t.cpuRes += n.cpu.allocated;
			t.memCap += n.memory.total;
			t.memRes += n.memory.allocated;
			t.memUsed += liveByNode.get(n.ID)?.memUsedMB ?? 0;
		}
		return t;
	}, [nodes, liveByNode]);

	// Top projects by memory usage (live), with reserved for context.
	const topProjects = useMemo(
		() =>
			[...(projectMetrics?.projects ?? [])]
				.filter((p) => p.memoryMb > 0 || p.cpuUsedMhz > 0)
				.sort((a, b) => b.memoryMb - a.memoryMb)
				.slice(0, 8),
		[projectMetrics],
	);

	if (isPending) {
		return (
			<div className="flex h-40 items-center justify-center text-muted-foreground text-sm">
				Loading cluster metrics…
			</div>
		);
	}

	if (!nodes || nodes.length === 0) {
		return (
			<Card className="bg-background">
				<CardContent className="p-6 text-muted-foreground text-sm">
					No Nomad nodes reachable. Check the control plane is up (see the{" "}
					<a href="/dashboard/nomad" className="underline">
						Nomad
					</a>{" "}
					tab).
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			{/* ── Cluster summary tiles ─────────────────────────────────────────── */}
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Tile
					icon={<Server className="size-5" />}
					label="Nodes"
					value={`${totals.ready}/${totals.nodes}`}
					sub="ready"
				/>
				<Tile
					icon={<Boxes className="size-5" />}
					label="Allocations"
					value={`${totals.allocs}`}
					sub="running"
				/>
				<Tile
					icon={<Cpu className="size-5" />}
					label="CPU reserved"
					value={`${pct(totals.cpuRes, totals.cpuCap)}%`}
					sub={`${fmtMhz(totals.cpuRes)} / ${fmtMhz(totals.cpuCap)}`}
				/>
				<Tile
					icon={<MemoryStick className="size-5" />}
					label="Memory"
					value={`${pct(totals.memUsed || totals.memRes, totals.memCap)}%`}
					sub={`${fmtMb(totals.memUsed || totals.memRes)} / ${fmtMb(totals.memCap)}${totals.memUsed ? " used" : " reserved"}`}
				/>
			</div>

			{/* ── Per-node utilization ──────────────────────────────────────────── */}
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="flex flex-row gap-2 text-xl">
						<Activity className="size-5 self-center text-muted-foreground" />
						Nodes
					</CardTitle>
					<CardDescription>
						Live host usage (solid) over scheduled/reserved (band) against each
						node's capacity. Sampled continuously.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{(nodes ?? []).map((n) => {
						const l = liveByNode.get(n.ID);
						const cpuUsedMhz = l?.ok
							? Math.round((l.cpuPercent / 100) * n.cpu.total)
							: 0;
						return (
							<div
								key={n.ID}
								className="flex flex-col gap-2 rounded-md border p-3"
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div className="flex items-center gap-2">
										<span className="font-medium font-mono text-sm">
											{n.Name}
										</span>
										<Badge
											variant="outline"
											className={
												n.Status === "ready"
													? "border-emerald-500/40 text-emerald-500"
													: "border-destructive/40 text-destructive"
											}
										>
											{n.Status}
										</Badge>
									</div>
									<span className="text-muted-foreground text-xs">
										{n.allocCount} alloc{n.allocCount === 1 ? "" : "s"}
										{n.Datacenter ? ` · ${n.Datacenter}` : ""}
									</span>
								</div>
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="flex flex-col gap-1">
										<div className="flex justify-between text-muted-foreground text-xs">
											<span className="flex items-center gap-1">
												<Cpu className="size-3" /> CPU
											</span>
											<span>
												{l?.ok ? `${l.cpuPercent}% used · ` : ""}
												{pct(n.cpu.allocated, n.cpu.total)}% reserved
											</span>
										</div>
										<UtilBar
											used={cpuUsedMhz}
											reserved={n.cpu.allocated}
											total={n.cpu.total}
										/>
										<span className="text-muted-foreground text-[11px]">
											{fmtMhz(n.cpu.allocated)} reserved / {fmtMhz(n.cpu.total)}
										</span>
									</div>
									<div className="flex flex-col gap-1">
										<div className="flex justify-between text-muted-foreground text-xs">
											<span className="flex items-center gap-1">
												<MemoryStick className="size-3" /> Memory
											</span>
											<span>
												{l?.ok ? `${l.memPercent}% used · ` : ""}
												{pct(n.memory.allocated, n.memory.total)}% reserved
											</span>
										</div>
										<UtilBar
											used={l?.memUsedMB ?? 0}
											reserved={n.memory.allocated}
											total={n.memory.total}
										/>
										<span className="text-muted-foreground text-[11px]">
											{l?.ok ? `${fmtMb(l.memUsedMB)} used · ` : ""}
											{fmtMb(n.memory.allocated)} reserved /{" "}
											{fmtMb(n.memory.total)}
										</span>
									</div>
								</div>
							</div>
						);
					})}
				</CardContent>
			</Card>

			{/* ── Top projects by usage ─────────────────────────────────────────── */}
			{topProjects.length > 0 && (
				<Card className="bg-background">
					<CardHeader>
						<CardTitle className="text-xl">Top projects by usage</CardTitle>
						<CardDescription>
							Live CPU/memory per project (used vs reserved), from Nomad
							telemetry.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="flex flex-col gap-1.5">
							{topProjects.map((p) => (
								<div
									key={p.projectId}
									className="flex items-center justify-between rounded-md border px-2.5 py-1.5 text-sm"
								>
									<span className="truncate font-medium">
										{projectName.get(p.projectId) ?? p.projectId}
									</span>
									<div className="flex items-center gap-4 text-muted-foreground text-xs">
										<span className="flex items-center gap-1">
											<Cpu className="size-3" />
											{p.cpuReservedMhz > 0
												? `${p.cpuUsedMhz} / ${p.cpuReservedMhz} MHz`
												: `${p.cpuPercent}%`}
										</span>
										<span className="flex items-center gap-1">
											<MemoryStick className="size-3" />
											{fmtMb(p.memoryMb)}
											{p.memReservedMb > 0
												? ` / ${fmtMb(p.memReservedMb)}`
												: ""}
										</span>
									</div>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
};
