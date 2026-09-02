import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";
export const DockerLogs = dynamic(
	() =>
		import("@/components/dashboard/docker/logs/docker-logs-id").then(
			(e) => e.DockerLogsId,
		),
	{
		ssr: false,
	},
);

export const badgeStateColor = (state: string) => {
	switch (state) {
		case "running":
		case "ready":
			return "green";
		case "exited":
		case "shutdown":
			return "red";
		case "accepted":
		case "created":
			return "blue";
		default:
			return "default";
	}
};

interface Props {
	appName: string;
	serverId?: string;
	appType?: "stack" | "docker-compose" | "nomad";
}

// Nomad-scheduled apps: logs come from the running allocation of the app's job
// (jobId === appName), via the Nomad API (works across cluster nodes) rather
// than a local docker container.
const NomadAppLogs = ({
	appName,
	serverId,
}: {
	appName: string;
	serverId?: string;
}) => {
	const { data: allocs, isPending } = api.nomad.getJobAllocations.useQuery(
		{ jobId: appName, serverId },
		{ enabled: !!appName, refetchInterval: 10000 },
	);
	// biome-ignore lint/suspicious/noExplicitAny: raw Nomad alloc stubs
	const running = (allocs || []).filter(
		(a: any) => a.ClientStatus === "running",
	);
	const [allocId, setAllocId] = useState<string | undefined>();
	const [logType, setLogType] = useState<"stdout" | "stderr">("stdout");

	useEffect(() => {
		if (!allocId && running.length > 0) setAllocId(running[0].ID);
	}, [running, allocId]);

	// biome-ignore lint/suspicious/noExplicitAny: raw Nomad alloc stub
	const current: any = running.find((a: any) => a.ID === allocId);
	const taskName = current?.TaskGroup as string | undefined;

	const { data: logs, isLoading } = api.nomad.getAllocationLogs.useQuery(
		{
			allocId: allocId || "",
			taskName: taskName || "",
			logType,
			serverId,
		},
		{ enabled: !!allocId && !!taskName, refetchInterval: 5000 },
	);

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Logs</CardTitle>
				<CardDescription>
					Logs from the running Nomad allocation, in real time
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-row gap-2 items-center flex-wrap">
					<Select onValueChange={setAllocId} value={allocId}>
						<SelectTrigger className="flex-1 min-w-[240px]">
							{isPending ? (
								<div className="flex flex-row gap-2 items-center text-sm text-muted-foreground">
									<span>Loading...</span>
									<Loader2 className="animate-spin size-4" />
								</div>
							) : (
								<SelectValue placeholder="Select an allocation" />
							)}
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{running.map((a: any) => (
									<SelectItem key={a.ID} value={a.ID}>
										{a.TaskGroup} ({a.ID.slice(0, 8)}){" "}
										<Badge variant="green">running</Badge>
									</SelectItem>
								))}
								<SelectLabel>Allocations ({running.length})</SelectLabel>
							</SelectGroup>
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
				<pre className="bg-black text-green-400 p-4 rounded-lg overflow-auto max-h-[500px] text-xs font-mono whitespace-pre-wrap">
					{!allocId
						? "No running allocation"
						: isLoading
							? "Loading..."
							: logs || "No logs available"}
				</pre>
			</CardContent>
		</Card>
	);
};

export const ShowDockerLogs = ({ appName, serverId, appType }: Props) => {
	if (appType === "nomad") {
		return <NomadAppLogs appName={appName} serverId={serverId} />;
	}
	const [containerId, setContainerId] = useState<string | undefined>();
	const [option, setOption] = useState<"swarm" | "native">("native");

	const { data: services, isPending: servicesLoading } =
		api.docker.getServiceContainersByAppName.useQuery(
			{
				appName,
				serverId,
			},
			{
				enabled: !!appName && option === "swarm",
			},
		);

	const { data: containers, isPending: containersLoading } =
		api.docker.getContainersByAppNameMatch.useQuery(
			{
				appName,
				serverId,
			},
			{
				enabled: !!appName && option === "native",
			},
		);

	useEffect(() => {
		if (option === "native") {
			if (containers && containers?.length > 0) {
				setContainerId(containers[0]?.containerId);
			}
		} else {
			if (services && services?.length > 0) {
				setContainerId(services[0]?.containerId);
			}
		}
	}, [option, services, containers]);

	const isLoading = option === "native" ? containersLoading : servicesLoading;
	const containersLength =
		option === "native" ? containers?.length : services?.length;

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Logs</CardTitle>
				<CardDescription>
					Watch the logs of the application in real time
				</CardDescription>
			</CardHeader>

			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-row justify-between items-center gap-2">
					<Label>Select a container to view logs</Label>
					<div className="flex flex-row gap-2 items-center">
						<span className="text-sm text-muted-foreground">
							{option === "native" ? "Native" : "Swarm"}
						</span>
						<Switch
							checked={option === "native"}
							onCheckedChange={(checked) => {
								setOption(checked ? "native" : "swarm");
							}}
						/>
					</div>
				</div>

				<Select onValueChange={setContainerId} value={containerId}>
					<SelectTrigger>
						{isLoading ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : (
							<SelectValue placeholder="Select a container" />
						)}
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{option === "native" ? (
								<div>
									{containers?.map((container) => (
										<SelectItem
											key={container.containerId}
											value={container.containerId}
										>
											{container.name} ({container.containerId}){" "}
											<Badge variant={badgeStateColor(container.state)}>
												{container.state}
											</Badge>
											{container.status ? ` ${container.status}` : ""}
										</SelectItem>
									))}
								</div>
							) : (
								<>
									{services?.map((container) => (
										<SelectItem
											key={container.containerId}
											value={container.containerId}
										>
											{container.name} ({container.containerId}@{container.node}
											)
											<Badge variant={badgeStateColor(container.state)}>
												{container.state}
											</Badge>
											{container.currentState
												? ` ${container.currentState}`
												: ""}
										</SelectItem>
									))}
								</>
							)}

							<SelectLabel>Containers ({containersLength})</SelectLabel>
						</SelectGroup>
					</SelectContent>
				</Select>
				{option === "swarm" &&
					services?.find((c) => c.containerId === containerId)?.error && (
						<div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
							<span className="font-medium">Error: </span>
							{services?.find((c) => c.containerId === containerId)?.error}
						</div>
					)}
				<DockerLogs
					serverId={serverId || ""}
					containerId={containerId || "select-a-container"}
					runType={option}
				/>
			</CardContent>
		</Card>
	);
};
