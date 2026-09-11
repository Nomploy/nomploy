import {
	AlertTriangle,
	Cpu,
	Loader2,
	MemoryStick,
	RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

interface Props {
	appName: string;
	serverId?: string;
}

export const ShowNomadAllocations = ({ appName, serverId }: Props) => {
	const {
		data: allocs,
		isLoading,
		isError,
		refetch,
	} = api.nomad.getJobAllocations.useQuery(
		{ jobId: appName, serverId },
		{ enabled: !!appName, refetchInterval: 10000 },
	);

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
					Failed to fetch allocations from Nomad
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-center justify-between">
				<div>
					<CardTitle className="text-xl">Allocations</CardTitle>
				</div>
				<Button variant="ghost" size="icon" onClick={() => refetch()}>
					<RefreshCw className="h-4 w-4" />
				</Button>
			</CardHeader>
			<CardContent className="space-y-3">
				{allocs?.length === 0 && (
					<p className="text-center text-muted-foreground py-4">
						No allocations found
					</p>
				)}
				{allocs?.map((alloc: any) => (
					<AllocationRow key={alloc.ID} alloc={alloc} serverId={serverId} />
				))}
			</CardContent>
		</Card>
	);
};

const AllocationRow = ({
	alloc,
	serverId,
}: {
	alloc: any;
	serverId?: string;
}) => {
	const [open, setOpen] = useState(false);
	const [logType, setLogType] = useState<"stdout" | "stderr">("stdout");

	// Nomad's logs endpoint needs the TASK name, not the group. For nomploy-
	// translated jobs they're equal, but native-HCL / Nomad Pack jobs often
	// differ (e.g. group "web", task "server"), so read the actual task from the
	// allocation's TaskStates and fall back to the group name.
	const taskName =
		(alloc.TaskStates && Object.keys(alloc.TaskStates)[0]) || alloc.TaskGroup;

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<div className="border rounded-lg p-3">
				<CollapsibleTrigger className="w-full">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<StatusBadge status={alloc.ClientStatus} />
							<span className="font-mono text-sm">{alloc.ID.slice(0, 8)}</span>
							<span className="text-sm text-muted-foreground">
								{alloc.TaskGroup}
							</span>
						</div>
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<span>v{alloc.JobVersion}</span>
							<span>{alloc.ClientStatus === "running" ? "▼ Logs" : ""}</span>
						</div>
					</div>
				</CollapsibleTrigger>

				<CollapsibleContent>
					{alloc.ClientStatus === "running" && (
						<div className="mt-3 space-y-3">
							<AllocMetrics allocId={alloc.ID} serverId={serverId} />
							<div className="flex gap-2">
								<Select
									value={logType}
									onValueChange={(v) => setLogType(v as "stdout" | "stderr")}
								>
									<SelectTrigger className="w-[100px] h-7 text-xs">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="stdout">stdout</SelectItem>
										<SelectItem value="stderr">stderr</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<AllocLogViewer
								allocId={alloc.ID}
								taskName={taskName}
								logType={logType}
								serverId={serverId}
							/>
						</div>
					)}
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
};

// Live per-allocation resource usage — actual CPU (MHz) / memory (MB) this
// running alloc is consuming, versus its reservation. Polled every 5s.
const AllocMetrics = ({
	allocId,
	serverId,
}: {
	allocId: string;
	serverId?: string;
}) => {
	const { data: m } = api.nomad.getAllocationMetrics.useQuery(
		{ allocId, serverId },
		{ refetchInterval: 5000 },
	);

	if (!m?.ok) {
		return (
			<p className="text-xs text-muted-foreground italic">
				live metrics unavailable
			</p>
		);
	}

	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2">
				<Cpu className="h-3 w-3 shrink-0 text-muted-foreground" />
				<Progress value={Math.min(m.cpu.percent, 100)} className="h-2 flex-1" />
				<span className="text-xs text-muted-foreground w-32 text-right tabular-nums">
					{m.cpu.usedMhz}/{m.cpu.reservedMhz} MHz · {m.cpu.percent}%
				</span>
			</div>
			<div className="flex items-center gap-2">
				<MemoryStick className="h-3 w-3 shrink-0 text-muted-foreground" />
				<Progress
					value={Math.min(m.memory.percent, 100)}
					className="h-2 flex-1"
				/>
				<span className="text-xs text-muted-foreground w-32 text-right tabular-nums">
					{m.memory.usedMB}/{m.memory.reservedMB} MB · {m.memory.percent}%
				</span>
			</div>
		</div>
	);
};

const AllocLogViewer = ({
	allocId,
	taskName,
	logType,
	serverId,
}: {
	allocId: string;
	taskName: string;
	logType: "stdout" | "stderr";
	serverId?: string;
}) => {
	const {
		data: logs,
		isLoading,
		refetch,
	} = api.nomad.getAllocationLogs.useQuery(
		{ allocId, taskName, logType, serverId },
		{ refetchInterval: 5000 },
	);

	return (
		<div className="relative">
			<Button
				variant="ghost"
				size="sm"
				className="absolute top-1 right-1 z-10 h-6 w-6 p-0"
				onClick={() => refetch()}
			>
				<RefreshCw className="h-3 w-3" />
			</Button>
			<pre className="bg-black text-green-400 p-3 rounded-md overflow-auto max-h-[300px] text-xs font-mono whitespace-pre-wrap">
				{isLoading && "Loading..."}
				{!isLoading && (logs || "No logs available")}
			</pre>
		</div>
	);
};

const StatusBadge = ({ status }: { status: string }) => {
	const variant =
		status === "running"
			? "default"
			: status === "complete"
				? "secondary"
				: "destructive";

	return <Badge variant={variant}>{status}</Badge>;
};
