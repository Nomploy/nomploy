import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
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
		case "failed":
		case "lost":
			return "red";
		case "accepted":
		case "created":
		case "pending":
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
const NomadAppLogs = ({ appName }: { appName: string; serverId?: string }) => {
	// Nomad is ONE cluster managed by the control-plane agent (the panel holds its
	// token); worker/other server nodes don't independently serve authed Nomad
	// queries — the deploy path already submits every job from the control plane
	// for exactly this reason. So logs/allocations are always read from the control
	// plane (serverId omitted), regardless of which node the job is pinned to;
	// /client/fs/logs is forwarded to the owning node by the server. Passing the
	// resource's serverId here queried that server's (empty/misconfigured) Nomad
	// and returned no allocations, so a running DB showed "No running allocation".
	const { data: allocs, isPending } = api.nomad.getJobAllocations.useQuery(
		{ jobId: appName },
		{ enabled: !!appName, refetchInterval: 10000 },
	);
	// Show EVERY allocation, newest first — not just running ones. A database (or
	// app) that is still starting or that crash-looped on boot has no running
	// alloc, and its logs are exactly what explains why; filtering to running hid
	// them. Nomad keeps a dead alloc's logs until GC, so we can still read them.
	// biome-ignore lint/suspicious/noExplicitAny: raw Nomad alloc stubs
	const sorted = [...(allocs || [])].sort(
		// biome-ignore lint/suspicious/noExplicitAny: raw Nomad alloc stubs
		(a: any, b: any) => (b.CreateTime ?? 0) - (a.CreateTime ?? 0),
	);
	const [allocId, setAllocId] = useState<string | undefined>();
	const [logType, setLogType] = useState<"stdout" | "stderr">("stdout");

	useEffect(() => {
		if (allocId && sorted.some((a: any) => a.ID === allocId)) return;
		// Prefer the newest running alloc; otherwise the newest alloc overall (so a
		// crashed/pending deploy still surfaces its logs).
		// biome-ignore lint/suspicious/noExplicitAny: raw Nomad alloc stubs
		const preferred =
			sorted.find((a: any) => a.ClientStatus === "running") ?? sorted[0];
		if (preferred) setAllocId(preferred.ID);
	}, [sorted, allocId]);

	// biome-ignore lint/suspicious/noExplicitAny: raw Nomad alloc stub
	const current: any = sorted.find((a: any) => a.ID === allocId);
	const taskName = current?.TaskGroup as string | undefined;

	const { data: logs, isLoading } = api.nomad.getAllocationLogs.useQuery(
		{
			allocId: allocId || "",
			taskName: taskName || "",
			logType,
		},
		{ enabled: !!allocId && !!taskName, refetchInterval: 5000 },
	);

	// Tail to the newest lines on load and each refresh.
	const scrollRef = useRef<HTMLPreElement>(null);
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [logs]);

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Logs</CardTitle>
				<CardDescription>
					Logs from the Nomad allocation, in real time (pick an older/failed
					allocation to see why a deploy didn't start)
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
								{/* biome-ignore lint/suspicious/noExplicitAny: raw Nomad alloc stubs */}
								{sorted.map((a: any) => (
									<SelectItem key={a.ID} value={a.ID}>
										{a.TaskGroup} ({a.ID.slice(0, 8)}){" "}
										<Badge variant={badgeStateColor(a.ClientStatus)}>
											{a.ClientStatus}
										</Badge>
									</SelectItem>
								))}
								<SelectLabel>Allocations ({sorted.length})</SelectLabel>
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
				<pre
					ref={scrollRef}
					className="bg-black text-green-400 p-4 rounded-lg overflow-auto max-h-[500px] text-xs font-mono whitespace-pre-wrap"
				>
					{!allocId
						? sorted.length === 0
							? "No allocations yet"
							: "Select an allocation"
						: isLoading
							? "Loading..."
							: logs || "No logs available"}
				</pre>
			</CardContent>
		</Card>
	);
};

export const ShowDockerLogs = ({ appName, serverId, appType }: Props) =>
	appType === "nomad" ? (
		<NomadAppLogs appName={appName} serverId={serverId} />
	) : (
		<DockerAppLogs appName={appName} serverId={serverId} />
	);

const DockerAppLogs = ({
	appName,
	serverId,
}: {
	appName: string;
	serverId?: string;
}) => {
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
