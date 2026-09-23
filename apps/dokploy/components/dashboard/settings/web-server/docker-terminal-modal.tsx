import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import type React from "react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import { badgeStateColor } from "../../application/logs/show";

const Terminal = dynamic(
	() =>
		import("@/components/dashboard/docker/terminal/docker-terminal").then(
			(e) => e.DockerTerminal,
		),
	{
		ssr: false,
	},
);

interface Props {
	appName: string;
	children?: React.ReactNode;
	serverId?: string;
	appType?: "stack" | "docker-compose" | "nomad";
}

export const DockerTerminalModal = ({
	children,
	appName,
	serverId,
	appType,
}: Props) => {
	const isNomad = appType === "nomad";

	const { data, isPending } = api.docker.getContainersByAppNameMatch.useQuery(
		{
			appName,
			appType,
			serverId,
		},
		{
			enabled: !!appName && !isNomad,
		},
	);

	const { data: nomadAllocs, isPending: nomadPending } =
		api.nomad.getJobAllocations.useQuery(
			{ jobId: appName },
			{ enabled: !!appName && isNomad },
		);

	const [containerId, setContainerId] = useState<string | undefined>();
	const [nomadAllocId, setNomadAllocId] = useState<string | undefined>();
	const [nomadTaskName, setNomadTaskName] = useState<string | undefined>();
	const [mainDialogOpen, setMainDialogOpen] = useState(false);
	const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

	const handleMainDialogOpenChange = (open: boolean) => {
		if (!open) {
			setConfirmDialogOpen(true);
		} else {
			setMainDialogOpen(true);
		}
	};

	const handleConfirm = () => {
		setConfirmDialogOpen(false);
		setMainDialogOpen(false);
	};

	const handleCancel = () => {
		setConfirmDialogOpen(false);
	};

	// `nomad alloc exec -task` needs the real TASK name, not the group. A compose
	// deploy packs every service as a task in ONE group (group "app", tasks
	// "norish"/"worker"/…), so passing TaskGroup fails with "Could not find task".
	// Read the tasks from the alloc's TaskStates; fall back to the group name for a
	// single-task job where group == task.
	const tasksOf = (alloc: any): string[] =>
		alloc?.TaskStates && Object.keys(alloc.TaskStates).length > 0
			? Object.keys(alloc.TaskStates)
			: alloc
				? [alloc.TaskGroup]
				: [];
	const selectedAlloc = nomadAllocs?.find((a: any) => a.ID === nomadAllocId);
	const taskNames = tasksOf(selectedAlloc);

	useEffect(() => {
		if (isNomad && nomadAllocs) {
			const running = (nomadAllocs as any[]).filter(
				(a) => a.ClientStatus === "running",
			);
			if (running.length > 0) {
				setNomadAllocId(running[0].ID);
				setNomadTaskName(tasksOf(running[0])[0]);
			}
		} else if (data && data?.length > 0) {
			setContainerId(data[0]?.containerId);
		}
	}, [data, nomadAllocs, isNomad]);

	return (
		<Dialog open={mainDialogOpen} onOpenChange={handleMainDialogOpenChange}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent
				className="max-h-[85vh] sm:max-w-7xl"
				onEscapeKeyDown={(event) => event.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>{isNomad ? "Nomad" : "Docker"} Terminal</DialogTitle>
					<DialogDescription>
						Easy way to access to{" "}
						{isNomad ? "nomad allocation" : "docker container"}
					</DialogDescription>
				</DialogHeader>
				{isNomad ? (
					<div className="flex gap-2">
						<Select
							onValueChange={(v) => {
								const alloc = nomadAllocs?.find((a: any) => a.ID === v);
								setNomadAllocId(v);
								if (alloc) setNomadTaskName(tasksOf(alloc)[0]);
							}}
							value={nomadAllocId}
						>
							<SelectTrigger>
								{nomadPending ? (
									<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground">
										<span>Loading...</span>
										<Loader2 className="animate-spin size-4" />
									</div>
								) : (
									<SelectValue placeholder="Select an allocation" />
								)}
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{nomadAllocs
										?.filter((a: any) => a.ClientStatus === "running")
										.map((alloc: any) => (
											<SelectItem key={alloc.ID} value={alloc.ID}>
												{alloc.TaskGroup} ({alloc.ID.slice(0, 8)})
												<Badge variant="default">running</Badge>
											</SelectItem>
										))}
								</SelectGroup>
							</SelectContent>
						</Select>
						{taskNames.length > 1 && (
							<Select value={nomadTaskName} onValueChange={setNomadTaskName}>
								<SelectTrigger className="w-[200px]">
									<SelectValue placeholder="Select a task" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										<SelectLabel>Task (service)</SelectLabel>
										{taskNames.map((t) => (
											<SelectItem key={t} value={t}>
												{t}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						)}
					</div>
				) : (
					<Select onValueChange={setContainerId} value={containerId}>
						<SelectTrigger>
							{isPending ? (
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
								{data?.map((container) => (
									<SelectItem
										key={container.containerId}
										value={container.containerId}
									>
										{container.name} ({container.containerId}){" "}
										<Badge variant={badgeStateColor(container.state)}>
											{container.state}
										</Badge>
									</SelectItem>
								))}
								<SelectLabel>Containers ({data?.length})</SelectLabel>
							</SelectGroup>
						</SelectContent>
					</Select>
				)}
				<Terminal
					serverId={serverId || ""}
					id="terminal"
					containerId={
						isNomad
							? nomadAllocId || "select-allocation"
							: containerId || "select-a-container"
					}
					{...(isNomad && {
						wsPath: "/nomad-terminal",
						taskName: nomadTaskName,
					})}
				/>
				<Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
					<DialogContent onEscapeKeyDown={(event) => event.preventDefault()}>
						<DialogHeader>
							<DialogTitle>
								Are you sure you want to close the terminal?
							</DialogTitle>
							<DialogDescription>
								By clicking the confirm button, the terminal will be closed.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="outline" onClick={handleCancel}>
								Cancel
							</Button>
							<Button onClick={handleConfirm}>Confirm</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</DialogContent>
		</Dialog>
	);
};
