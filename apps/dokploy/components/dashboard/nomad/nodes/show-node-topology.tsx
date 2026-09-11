import {
	AlertTriangle,
	Box,
	Cpu,
	Crown,
	Loader2,
	MemoryStick,
	RefreshCw,
	Server,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { api } from "@/utils/api";

const pct = (used: number, total: number) =>
	total > 0 ? Math.round((used / total) * 100) : 0;

// Nomad reports CPU capacity as total MHz (CpuShares) and memory as MB.
const ghz = (mhz: number) => (mhz / 1000).toFixed(1);
const gb = (mb: number) => (mb / 1024).toFixed(1);

/**
 * Infrastructure topology: one card per Nomad node showing its size (CPU/RAM
 * capacity), role, live utilization, and the allocations actually running on it.
 * Answers "how big is each node and what's running where".
 */
export const ShowNodeTopology = ({ serverId }: { serverId?: string }) => {
	const {
		data: nodes,
		isLoading,
		isError,
		refetch,
		isRefetching,
	} = api.nomad.getNodeTopology.useQuery({ serverId });
	// Live (actual) usage, polled — the real-time complement to reservations.
	const { data: metrics } = api.nomad.getClusterMetrics.useQuery(
		{ serverId },
		{ refetchInterval: 5000 },
	);
	const liveByNode = new Map((metrics ?? []).map((m) => [m.nodeId, m]));

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8">
				<Loader2 className="h-6 w-6 animate-spin" />
			</div>
		);
	}

	if (isError) {
		return (
			<Alert variant="destructive">
				<AlertTriangle className="h-4 w-4" />
				<AlertDescription>
					Failed to connect to Nomad. Is it running?
				</AlertDescription>
			</Alert>
		);
	}

	// Largest node's CPU capacity drives the relative "size" bar across the fleet.
	const maxCpu = Math.max(1, ...(nodes ?? []).map((n) => n.cpu.total || 0));

	// Cluster-wide live totals (from the polled metrics).
	const liveNodes = (metrics ?? []).filter((m) => m.ok);
	const avgCpu = liveNodes.length
		? Math.round(
				liveNodes.reduce((a, m) => a + m.cpuPercent, 0) / liveNodes.length,
			)
		: null;
	const totMemUsed = liveNodes.reduce((a, m) => a + m.memUsedMB, 0);
	const totMemTotal = liveNodes.reduce((a, m) => a + m.memTotalMB, 0);

	return (
		<Card className="bg-sidebar rounded-xl">
			<CardHeader className="flex flex-row items-center justify-between">
				<div>
					<CardTitle className="text-xl">Infrastructure</CardTitle>
					<p className="text-sm text-muted-foreground">
						Node sizes and what's running on each — {nodes?.length ?? 0} node
						{(nodes?.length ?? 0) === 1 ? "" : "s"}
						{avgCpu != null && (
							<>
								{" · live "}
								{avgCpu}% cpu · {(totMemUsed / 1024).toFixed(1)}/
								{(totMemTotal / 1024).toFixed(1)} GB mem
							</>
						)}
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon"
					onClick={() => refetch()}
					disabled={isRefetching}
				>
					<RefreshCw
						className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`}
					/>
				</Button>
			</CardHeader>
			<CardContent>
				{(!nodes || nodes.length === 0) && (
					<p className="text-center text-muted-foreground py-8">
						No nodes found
					</p>
				)}
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
					{nodes?.map((node) => {
						const cpuP = pct(node.cpu.allocated, node.cpu.total);
						const memP = pct(node.memory.allocated, node.memory.total);
						const sizeP = Math.round(((node.cpu.total || 0) / maxCpu) * 100);
						const ready = node.Status === "ready";
						const role =
							node.role === "control-plane"
								? "Control plane"
								: node.role === "server"
									? "Server"
									: "Worker";
						const live = liveByNode.get(node.ID);
						return (
							<div
								key={node.ID}
								className={`rounded-xl border p-4 flex flex-col gap-3 bg-background ${
									node.isControlPlane ? "border-primary/50" : "border-border"
								} ${node.drain ? "opacity-70" : ""}`}
							>
								{/* Header: name + role + status */}
								<div className="flex items-start justify-between gap-2">
									<div className="flex items-center gap-2 min-w-0">
										{node.isControlPlane ? (
											<Crown className="h-4 w-4 shrink-0 text-primary" />
										) : (
											<Server className="h-4 w-4 shrink-0 text-muted-foreground" />
										)}
										<span className="font-medium truncate" title={node.Name}>
											{node.Name}
										</span>
									</div>
									<div className="flex items-center gap-1 shrink-0">
										<Badge variant={ready ? "default" : "destructive"}>
											{node.Status}
										</Badge>
										{node.drain && <Badge variant="secondary">draining</Badge>}
										{!node.drain && node.eligibility === "ineligible" && (
											<Badge variant="secondary">cordoned</Badge>
										)}
									</div>
								</div>

								{/* Size + relative capacity bar */}
								<div className="flex items-center gap-3 text-xs text-muted-foreground">
									<Badge variant="outline">{role}</Badge>
									{node.nodePool && node.nodePool !== "default" && (
										<Badge variant="secondary" className="font-mono">
											{node.nodePool}
										</Badge>
									)}
									<span className="flex items-center gap-1">
										<Cpu className="h-3 w-3" /> {ghz(node.cpu.total)} GHz
									</span>
									<span className="flex items-center gap-1">
										<MemoryStick className="h-3 w-3" /> {gb(node.memory.total)}{" "}
										GB
									</span>
								</div>
								<div title="Capacity relative to the largest node">
									<Progress value={sizeP} className="h-1" />
								</div>

								{/* Utilization — live (actual) usage is the bar; reserved shown
								     below. Falls back to reserved if the node's stats are down. */}
								<div className="space-y-1.5">
									<div className="flex items-center gap-2">
										<span className="text-xs w-8 text-muted-foreground">
											CPU
										</span>
										<Progress
											value={live?.ok ? live.cpuPercent : cpuP}
											className="h-2 flex-1"
										/>
										<span className="text-xs text-muted-foreground w-16 text-right">
											{live?.ok ? `${live.cpuPercent}% live` : `${cpuP}% res`}
										</span>
									</div>
									<div className="flex items-center gap-2">
										<span className="text-xs w-8 text-muted-foreground">
											RAM
										</span>
										<Progress
											value={live?.ok ? live.memPercent : memP}
											className="h-2 flex-1"
										/>
										<span className="text-xs text-muted-foreground w-16 text-right">
											{live?.ok ? `${live.memPercent}% live` : `${memP}% res`}
										</span>
									</div>
									<p className="text-[11px] text-muted-foreground">
										{live?.ok
											? `reserved ${cpuP}% cpu · ${memP}% mem`
											: "live metrics unavailable"}
									</p>
								</div>

								{/* Running allocations */}
								<div className="mt-1">
									<div className="text-xs text-muted-foreground mb-1.5">
										Running here · {node.allocs.length}
									</div>
									{node.allocs.length === 0 ? (
										<p className="text-xs text-muted-foreground italic">
											nothing scheduled
										</p>
									) : (
										<div className="flex flex-wrap gap-1.5">
											{node.allocs.map((a) => (
												<span
													key={a.id}
													title={`${a.jobId} · ${a.taskGroup} · ${a.cpu} MHz · ${a.memory} MB`}
													className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs max-w-full"
												>
													<Box className="h-3 w-3 shrink-0 text-muted-foreground" />
													<span className="truncate max-w-[140px]">
														{a.jobId}
													</span>
												</span>
											))}
										</div>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
};
