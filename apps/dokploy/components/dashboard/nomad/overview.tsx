import {
	Activity,
	ArrowDownCircle,
	ArrowUpCircle,
	Boxes,
	Container,
	Cpu,
	Loader2,
	MemoryStick,
	Network,
	Server,
	ShieldCheck,
	ShieldX,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { api } from "@/utils/api";

// Local shapes — the nomad router's tRPC inference degrades to `{}` for some of
// these procedures (a known instantiation-depth quirk), so we cast the query
// data to exactly what we read here instead of relying on the inferred types.
interface Resources {
	cpu: { total: number; allocated: number };
	memory: { total: number; allocated: number };
	nodes: number;
	nodesReady: number;
	allocations: { running: number; total: number };
}
interface Metric {
	ok: boolean;
	cpuPercent: number;
	memUsedMB: number;
	memTotalMB: number;
}
interface Member {
	name: string;
	role: "server" | "worker";
	status?: string;
}
interface Dns {
	name?: string;
	ok: boolean;
}
interface GroupStatus {
	groupId: string;
	name: string;
	enabled: boolean;
	nodes?: unknown[];
	decision?: { action?: string; workerCount?: number } | null;
}
interface Ev {
	type: string;
	message: string;
	createdAt: string;
}

const relTime = (iso: string): string => {
	const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
	if (s < 60) return `${Math.floor(s)}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
};

const formatMB = (mb: number): string =>
	mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

/**
 * Cluster "mission control" — a single at-a-glance operational view above the
 * detail tabs: live + reserved CPU/memory, node & raft health, workloads, the
 * scheduler mode, cluster DNS, autoscaling groups, and recent activity. Polls so
 * it stays current. Everything here links conceptually to a detail tab below.
 */
export const NomadOverview = ({ serverId }: { serverId?: string }) => {
	const { data: resRaw, isLoading } = api.nomad.getClusterResources.useQuery(
		{ serverId },
		{ refetchInterval: 10000 },
	);
	const { data: metricsRaw } = api.nomad.getClusterMetrics.useQuery(
		{ serverId },
		{ refetchInterval: 10000 },
	);
	const { data: membersRaw } = api.nomad.getClusterMembers.useQuery(undefined, {
		refetchInterval: 30000,
		refetchOnWindowFocus: false,
	});
	const { data: schedRaw } = api.nomad.getSchedulerConfig.useQuery({
		serverId,
	});
	const { data: dnsRaw } = api.nomad.getClusterDnsHealth.useQuery(undefined, {
		refetchInterval: 30000,
		refetchOnWindowFocus: false,
	});
	const { data: groupsRaw } = api.nomad.getAutoscalerStatus.useQuery(
		undefined,
		{
			refetchInterval: 30000,
		},
	);
	const { data: eventsRaw } = api.nomad.getAutoscalerEvents.useQuery(
		undefined,
		{
			refetchInterval: 30000,
		},
	);

	if (isLoading || !resRaw) {
		return (
			<div className="flex items-center justify-center p-8">
				<Loader2 className="h-6 w-6 animate-spin" />
			</div>
		);
	}

	const res = resRaw as Resources;
	const metrics = (metricsRaw ?? []) as Metric[];
	const members = (membersRaw ?? []) as Member[];
	const sched = schedRaw as { algorithm: string } | undefined;
	const dns = (dnsRaw ?? []) as Dns[];
	const groups = (groupsRaw ?? []) as GroupStatus[];
	const events = (eventsRaw ?? []) as Ev[];

	// Reserved (what Nomad scheduled) vs live (what's actually used).
	const cpuReserved =
		res.cpu.total > 0
			? Math.round((res.cpu.allocated / res.cpu.total) * 100)
			: 0;
	const memReserved =
		res.memory.total > 0
			? Math.round((res.memory.allocated / res.memory.total) * 100)
			: 0;
	const liveNodes = metrics.filter((m) => m.ok);
	const cpuLive = liveNodes.length
		? Math.round(
				liveNodes.reduce((a, m) => a + m.cpuPercent, 0) / liveNodes.length,
			)
		: null;
	const memUsed = liveNodes.reduce((a, m) => a + m.memUsedMB, 0);
	const memTotalLive = liveNodes.reduce((a, m) => a + m.memTotalMB, 0);
	const memLive = memTotalLive
		? Math.round((memUsed / memTotalLive) * 100)
		: null;

	// Raft: server nodes drive quorum + fault tolerance.
	const serverCount = members.filter((m) => m.role === "server").length;
	const faultTolerance = Math.max(0, Math.floor((serverCount - 1) / 2));
	const dnsOk = dns.filter((d) => d.ok).length;

	return (
		<div className="space-y-4">
			{/* KPI row — live headline, reserved beneath */}
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">CPU</CardTitle>
						<Cpu className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{cpuLive != null ? `${cpuLive}%` : `${cpuReserved}%`}
							<span className="ml-1 text-xs font-normal text-muted-foreground">
								{cpuLive != null ? "live" : "reserved"}
							</span>
						</div>
						<Progress
							value={cpuLive != null ? cpuLive : cpuReserved}
							className="mt-2"
						/>
						<p className="text-xs text-muted-foreground mt-1">
							{cpuReserved}% reserved · {res.cpu.allocated}/{res.cpu.total} MHz
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Memory</CardTitle>
						<MemoryStick className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{memLive != null ? `${memLive}%` : `${memReserved}%`}
							<span className="ml-1 text-xs font-normal text-muted-foreground">
								{memLive != null ? "live" : "reserved"}
							</span>
						</div>
						<Progress
							value={memLive != null ? memLive : memReserved}
							className="mt-2"
						/>
						<p className="text-xs text-muted-foreground mt-1">
							{memReserved}% reserved · {formatMB(res.memory.allocated)}/
							{formatMB(res.memory.total)}
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Nodes</CardTitle>
						<Server className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">
							{res.nodesReady}
							<span className="text-muted-foreground">/{res.nodes}</span>
						</div>
						<p className="text-xs text-muted-foreground mt-1">
							{serverCount} server{serverCount === 1 ? "" : "s"} · tolerates{" "}
							{faultTolerance} failure{faultTolerance === 1 ? "" : "s"}
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="text-sm font-medium">Workloads</CardTitle>
						<Container className="h-4 w-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">{res.allocations.running}</div>
						<p className="text-xs text-muted-foreground mt-1">
							running · {res.allocations.total} total allocations
						</p>
					</CardContent>
				</Card>
			</div>

			{/* Health / autoscaling / activity row */}
			<div className="grid gap-4 lg:grid-cols-3">
				{/* Cluster health */}
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="flex items-center gap-2 text-sm font-medium">
							<Network className="h-4 w-4 text-muted-foreground" />
							Cluster health
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm">
						<div className="flex items-center justify-between">
							<span className="text-muted-foreground">Raft quorum</span>
							<span>
								{serverCount} server{serverCount === 1 ? "" : "s"}
								<Badge variant="outline" className="ml-2">
									tolerates {faultTolerance}
								</Badge>
							</span>
						</div>
						<div className="flex items-center justify-between">
							<span className="text-muted-foreground">Cluster DNS</span>
							<span className="flex items-center gap-1.5">
								{dns.length > 0 && dnsOk === dns.length ? (
									<ShieldCheck className="h-4 w-4 text-green-500" />
								) : (
									<ShieldX className="h-4 w-4 text-destructive" />
								)}
								{dns.length > 0 ? `${dnsOk}/${dns.length} resolvers` : "n/a"}
							</span>
						</div>
						<div className="flex items-center justify-between">
							<span className="text-muted-foreground">Scheduler</span>
							<Badge variant="secondary">{sched?.algorithm ?? "…"}</Badge>
						</div>
					</CardContent>
				</Card>

				{/* Autoscaling groups */}
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="flex items-center gap-2 text-sm font-medium">
							<Boxes className="h-4 w-4 text-muted-foreground" />
							Autoscaling
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm">
						{groups.length === 0 && (
							<p className="text-muted-foreground">No autoscaling groups</p>
						)}
						{groups.slice(0, 5).map((g) => (
							<div
								key={g.groupId}
								className="flex items-center justify-between gap-2"
							>
								<span className="flex items-center gap-1.5 min-w-0">
									<span
										className={`h-2 w-2 shrink-0 rounded-full ${
											g.enabled ? "bg-green-500" : "bg-muted-foreground/40"
										}`}
									/>
									<span className="truncate">{g.name}</span>
								</span>
								<span className="text-muted-foreground shrink-0">
									{g.decision?.workerCount ?? g.nodes?.length ?? 0} nodes
									{g.decision?.action && g.decision.action !== "none" && (
										<Badge variant="outline" className="ml-2">
											{g.decision.action}
										</Badge>
									)}
								</span>
							</div>
						))}
					</CardContent>
				</Card>

				{/* Recent activity */}
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="flex items-center gap-2 text-sm font-medium">
							<Activity className="h-4 w-4 text-muted-foreground" />
							Recent activity
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm">
						{events.length === 0 && (
							<p className="text-muted-foreground">No recent activity</p>
						)}
						{events.slice(0, 6).map((e, i) => (
							<div
								key={`${e.createdAt}-${i}`}
								className="flex items-start gap-2"
							>
								{e.type === "scale_up" ? (
									<ArrowUpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
								) : e.type === "scale_down" ? (
									<ArrowDownCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
								) : e.type === "error" ? (
									<ShieldX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
								) : (
									<Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
								)}
								<span className="min-w-0 flex-1">
									<span className="line-clamp-2">{e.message}</span>
									<span className="text-xs text-muted-foreground">
										{relTime(e.createdAt)}
									</span>
								</span>
							</div>
						))}
					</CardContent>
				</Card>
			</div>
		</div>
	);
};
