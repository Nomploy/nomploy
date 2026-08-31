import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

export const ShowNomadLogs = () => {
	const [selectedAlloc, setSelectedAlloc] = useState<string | null>(null);
	const [selectedTask, setSelectedTask] = useState<string>("");
	const [logType, setLogType] = useState<"stdout" | "stderr">("stdout");

	const {
		data: allocs,
		isLoading,
		isError,
		refetch,
	} = api.nomad.getAllocations.useQuery();

	const runningAllocs = allocs?.filter((a: any) => a.ClientStatus === "running") || [];

	const currentAlloc = runningAllocs.find((a: any) => a.ID === selectedAlloc);

	return (
		<Card className="bg-sidebar rounded-xl">
			<CardHeader className="flex flex-row items-center justify-between">
				<CardTitle className="text-xl">Logs</CardTitle>
				<Button variant="ghost" size="icon" onClick={() => refetch()}>
					<RefreshCw className="h-4 w-4" />
				</Button>
			</CardHeader>
			<CardContent className="space-y-4">
				{isLoading && (
					<div className="flex items-center justify-center p-8">
						<Loader2 className="h-6 w-6 animate-spin" />
					</div>
				)}

				{isError && (
					<Alert variant="destructive">
						<AlertTriangle className="h-4 w-4" />
						<AlertDescription>Failed to fetch allocations</AlertDescription>
					</Alert>
				)}

				{!isLoading && !isError && (
					<>
						<div className="flex gap-3 items-center flex-wrap">
							<Select
								value={selectedAlloc || ""}
								onValueChange={(v) => {
									setSelectedAlloc(v);
									const alloc = runningAllocs.find((a: any) => a.ID === v);
									if (alloc) setSelectedTask(alloc.TaskGroup);
								}}
							>
								<SelectTrigger className="w-[350px]">
									<SelectValue placeholder="Select allocation" />
								</SelectTrigger>
								<SelectContent>
									{runningAllocs.map((a: any) => (
										<SelectItem key={a.ID} value={a.ID}>
											{a.JobID} / {a.TaskGroup} ({a.ID.slice(0, 8)})
										</SelectItem>
									))}
								</SelectContent>
							</Select>

							<Select
								value={logType}
								onValueChange={(v) => setLogType(v as "stdout" | "stderr")}
							>
								<SelectTrigger className="w-[120px]">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="stdout">stdout</SelectItem>
									<SelectItem value="stderr">stderr</SelectItem>
								</SelectContent>
							</Select>
						</div>

						{selectedAlloc && selectedTask && (
							<LogViewer
								allocId={selectedAlloc}
								taskName={selectedTask}
								logType={logType}
							/>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
};

const LogViewer = ({
	allocId,
	taskName,
	logType,
}: {
	allocId: string;
	taskName: string;
	logType: "stdout" | "stderr";
}) => {
	const { data: logs, isLoading, refetch } = api.nomad.getAllocationLogs.useQuery(
		{ allocId, taskName, logType },
		{ refetchInterval: 5000 },
	);

	return (
		<div className="relative">
			<Button
				variant="ghost"
				size="sm"
				className="absolute top-2 right-2 z-10"
				onClick={() => refetch()}
			>
				<RefreshCw className="h-3 w-3" />
			</Button>
			<pre className="bg-black text-green-400 p-4 rounded-lg overflow-auto max-h-[500px] text-xs font-mono whitespace-pre-wrap">
				{isLoading && "Loading..."}
				{!isLoading && (logs || "No logs available")}
			</pre>
		</div>
	);
};
