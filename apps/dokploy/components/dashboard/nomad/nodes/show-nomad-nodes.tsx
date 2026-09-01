import { AlertTriangle, Loader2, RefreshCw, Server } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

export const ShowNomadNodes = ({ serverId }: { serverId?: string }) => {
	const {
		data: nodes,
		isLoading,
		isError,
		refetch,
	} = api.nomad.getNodes.useQuery({ serverId });

	const { data: resources } = api.nomad.getClusterResources.useQuery({
		serverId,
	});

	const { data: allocs } = api.nomad.getAllocations.useQuery({ serverId });

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

	return (
		<Card className="bg-sidebar rounded-xl">
			<CardHeader className="flex flex-row items-center justify-between">
				<CardTitle className="text-xl">Nomad Nodes</CardTitle>
				<Button variant="ghost" size="icon" onClick={() => refetch()}>
					<RefreshCw className="h-4 w-4" />
				</Button>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Datacenter</TableHead>
							<TableHead>Allocations</TableHead>
							<TableHead>CPU Allocated</TableHead>
							<TableHead>Memory Allocated</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{nodes?.map((node: any) => {
							const nodeAllocs =
								allocs?.filter(
									(a: any) =>
										a.NodeID === node.ID && a.ClientStatus === "running",
								) || [];

							const cpuTotal = resources?.cpu.total || 1;
							const memTotal = resources?.memory.total || 1;
							const cpuPercent =
								cpuTotal > 0
									? Math.round(
											((resources?.cpu.allocated || 0) / cpuTotal) * 100,
										)
									: 0;
							const memPercent =
								memTotal > 0
									? Math.round(
											((resources?.memory.allocated || 0) / memTotal) * 100,
										)
									: 0;

							return (
								<TableRow key={node.ID}>
									<TableCell className="font-medium">
										<div className="flex items-center gap-2">
											<Server className="h-4 w-4 text-muted-foreground" />
											{node.Name}
										</div>
									</TableCell>
									<TableCell>
										<Badge
											variant={
												node.Status === "ready" ? "default" : "destructive"
											}
										>
											{node.Status}
										</Badge>
									</TableCell>
									<TableCell>{node.Datacenter}</TableCell>
									<TableCell>{nodeAllocs.length} running</TableCell>
									<TableCell>
										<div className="flex items-center gap-2 min-w-[120px]">
											<Progress value={cpuPercent} className="h-2 flex-1" />
											<span className="text-xs text-muted-foreground w-8">
												{cpuPercent}%
											</span>
										</div>
									</TableCell>
									<TableCell>
										<div className="flex items-center gap-2 min-w-[120px]">
											<Progress value={memPercent} className="h-2 flex-1" />
											<span className="text-xs text-muted-foreground w-8">
												{memPercent}%
											</span>
										</div>
									</TableCell>
								</TableRow>
							);
						})}
						{(!nodes || nodes.length === 0) && (
							<TableRow>
								<TableCell
									colSpan={6}
									className="text-center text-muted-foreground"
								>
									No nodes found
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
};
