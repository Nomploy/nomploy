import {
	Container,
	Cpu,
	HardDrive,
	Loader2,
	MemoryStick,
	Server,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { api } from "@/utils/api";

export const NomadOverview = ({ serverId }: { serverId?: string }) => {
	const { data, isLoading } = api.nomad.getClusterResources.useQuery(
		{ serverId },
		{ refetchInterval: 10000 },
	);

	if (isLoading || !data) {
		return (
			<div className="flex items-center justify-center p-8">
				<Loader2 className="h-6 w-6 animate-spin" />
			</div>
		);
	}

	const cpuPercent =
		data.cpu.total > 0
			? Math.round((data.cpu.allocated / data.cpu.total) * 100)
			: 0;
	const memPercent =
		data.memory.total > 0
			? Math.round((data.memory.allocated / data.memory.total) * 100)
			: 0;

	return (
		<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
			<Card>
				<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
					<CardTitle className="text-sm font-medium">CPU</CardTitle>
					<Cpu className="h-4 w-4 text-muted-foreground" />
				</CardHeader>
				<CardContent>
					<div className="text-2xl font-bold">{cpuPercent}%</div>
					<Progress value={cpuPercent} className="mt-2" />
					<p className="text-xs text-muted-foreground mt-1">
						{data.cpu.allocated} / {data.cpu.total} MHz allocated
					</p>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
					<CardTitle className="text-sm font-medium">Memory</CardTitle>
					<MemoryStick className="h-4 w-4 text-muted-foreground" />
				</CardHeader>
				<CardContent>
					<div className="text-2xl font-bold">{memPercent}%</div>
					<Progress value={memPercent} className="mt-2" />
					<p className="text-xs text-muted-foreground mt-1">
						{formatMB(data.memory.allocated)} / {formatMB(data.memory.total)}{" "}
						allocated
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
						{data.nodesReady} / {data.nodes}
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						{data.nodesReady} ready
					</p>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
					<CardTitle className="text-sm font-medium">Allocations</CardTitle>
					<Container className="h-4 w-4 text-muted-foreground" />
				</CardHeader>
				<CardContent>
					<div className="text-2xl font-bold">{data.allocations.running}</div>
					<p className="text-xs text-muted-foreground mt-1">
						{data.allocations.running} running / {data.allocations.total} total
					</p>
				</CardContent>
			</Card>
		</div>
	);
};

const formatMB = (mb: number): string => {
	if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
	return `${mb} MB`;
};
