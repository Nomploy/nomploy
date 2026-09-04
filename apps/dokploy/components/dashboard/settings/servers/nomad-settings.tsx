import { zodResolver } from "@hookform/resolvers/zod";
import {
	Loader2,
	LogOut,
	Network,
	RefreshCw,
	Server as ServerIcon,
	Terminal,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

const nomadSchema = z.object({
	nomadAddress: z.string().url("Must be a valid URL").or(z.literal("")),
	nomadToken: z.string().optional(),
	nomadNamespace: z.string(),
	registryUrl: z.string().optional(),
});

type NomadFormValues = z.infer<typeof nomadSchema>;

type ClusterRole = "server" | "worker";

// Terminal marker the cluster subscriptions stream on any non-success completion
// (graceful abort or error), so the busy state clears even when there is no
// success sentinel. Must match OP_ENDED in the nomad router.
const OP_ENDED = "OP_ENDED";

interface Props {
	serverId: string;
}

export const NomadSettings = ({ serverId }: Props) => {
	const { data: server, refetch } = api.server.one.useQuery(
		{ serverId },
		{ enabled: !!serverId },
	);

	const { mutateAsync, isPending } = api.server.update.useMutation();

	const {
		data: members,
		refetch: refetchMembers,
		isRefetching: isRefetchingMembers,
	} = api.nomad.getClusterMembers.useQuery(undefined, {
		refetchOnWindowFocus: false,
	});

	const [isBootstrapping, setIsBootstrapping] = useState(false);
	const [bootstrapLogs, setBootstrapLogs] = useState<string>("");

	api.nomad.bootstrapServer.useSubscription(
		{ serverId },
		{
			enabled: isBootstrapping,
			onData(log) {
				if (log === "BOOTSTRAP_DONE") {
					setIsBootstrapping(false);
					toast.success("Nomad bootstrapped on this server");
					refetch();
					return;
				}
				if (log.includes(OP_ENDED)) {
					setIsBootstrapping(false);
					return;
				}
				setBootstrapLogs((prev) => prev + log);
			},
			onError(error) {
				setIsBootstrapping(false);
				toast.error(error.message || "Bootstrap failed");
			},
		},
	);

	const startBootstrap = () => {
		setBootstrapLogs("");
		setIsBootstrapping(true);
	};

	const [isJoining, setIsJoining] = useState(false);
	const [joinRole, setJoinRole] = useState<ClusterRole>("worker");
	const [joinLogs, setJoinLogs] = useState<string>("");

	api.nomad.joinCluster.useSubscription(
		{ serverId, role: joinRole },
		{
			enabled: isJoining,
			onData(log) {
				if (log === "JOIN_DONE") {
					setIsJoining(false);
					toast.success(
						joinRole === "server"
							? "Server joined the cluster (Nomad/Consul raft)"
							: "Worker joined the cluster",
					);
					refetch();
					refetchMembers();
					return;
				}
				if (log.includes(OP_ENDED)) {
					setIsJoining(false);
					return;
				}
				setJoinLogs((prev) => prev + log);
			},
			onError(error) {
				setIsJoining(false);
				toast.error(error.message || "Cluster join failed");
			},
		},
	);

	const startJoin = (role: ClusterRole) => {
		setJoinRole(role);
		setJoinLogs("");
		setIsJoining(true);
	};

	const [isLeaving, setIsLeaving] = useState(false);
	const [forceLeave, setForceLeave] = useState(false);
	const [leaveLogs, setLeaveLogs] = useState<string>("");
	// The member currently targeted for removal (any row in the table, or this
	// server). Drives both the confirm dialog and the removeNode subscription, so
	// you can remove any node from one place without opening its own settings.
	const [removeTarget, setRemoveTarget] = useState<{
		serverId: string;
		name: string;
		role: ClusterRole;
	} | null>(null);

	api.nomad.removeNode.useSubscription(
		{ serverId: removeTarget?.serverId ?? serverId, force: forceLeave },
		{
			enabled: isLeaving,
			onData(log) {
				if (log === "REMOVE_DONE") {
					setIsLeaving(false);
					toast.success(
						`${removeTarget?.name ?? "Node"} removed from the cluster`,
					);
					refetch();
					refetchMembers();
					return;
				}
				if (log.includes(OP_ENDED)) {
					setIsLeaving(false);
					return;
				}
				setLeaveLogs((prev) => prev + log);
			},
			onError(error) {
				setIsLeaving(false);
				toast.error(error.message || "Leave failed");
			},
		},
	);

	// Open the confirm dialog for a given member (reset force + logs each time).
	const openRemove = (target: {
		serverId: string;
		name: string;
		role: ClusterRole;
	}) => {
		setForceLeave(false);
		setLeaveLogs("");
		setRemoveTarget(target);
	};

	const startLeave = () => {
		setLeaveLogs("");
		setIsLeaving(true);
	};

	const serverCount = members?.filter((m) => m.role === "server").length ?? 0;
	// Raft fault tolerance: how many servers can fail while keeping quorum.
	const faultTolerance = Math.max(0, Math.floor((serverCount - 1) / 2));

	const isMember = !!server?.clusterRole;
	const busy = isBootstrapping || isJoining || isLeaving;

	const form = useForm<NomadFormValues>({
		resolver: zodResolver(nomadSchema),
		values: {
			nomadAddress: server?.nomadAddress || "",
			nomadToken: server?.nomadToken || "",
			nomadNamespace: server?.nomadNamespace || "default",
			registryUrl: server?.registryUrl || "",
		},
	});

	const onSubmit = async (data: NomadFormValues) => {
		if (!server) return;
		try {
			await mutateAsync({
				...server,
				...data,
				serverId,
			});
			toast.success("Nomad settings saved");
			refetch();
		} catch {
			toast.error("Failed to save Nomad settings");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1.5">
					<CardTitle className="text-xl">Nomad Configuration</CardTitle>
					<CardDescription>
						Configure Nomad cluster connection for deploying services.
					</CardDescription>
				</div>
				<div className="flex flex-col gap-2">
					<Button
						type="button"
						variant="secondary"
						onClick={startBootstrap}
						disabled={busy}
						title="Install a standalone Docker + Consul + Nomad + CNI on this server over SSH"
					>
						{isBootstrapping ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Terminal className="mr-2 h-4 w-4" />
						)}
						{isBootstrapping ? "Bootstrapping…" : "Bootstrap Nomad"}
					</Button>

					{isMember ? (
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={() =>
								server &&
								openRemove({
									serverId,
									name: server.name,
									role: (server.clusterRole as ClusterRole) ?? "worker",
								})
							}
						>
							{isLeaving ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<LogOut className="mr-2 h-4 w-4" />
							)}
							{isLeaving ? "Leaving…" : "Leave cluster"}
						</Button>
					) : (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button type="button" disabled={busy}>
									{isJoining ? (
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									) : (
										<Network className="mr-2 h-4 w-4" />
									)}
									{isJoining ? "Joining…" : "Join cluster"}
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => startJoin("worker")}>
									<Network className="mr-2 h-4 w-4" />
									Join as worker
									<span className="ml-2 text-xs text-muted-foreground">
										runs workloads
									</span>
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => startJoin("server")}>
									<ServerIcon className="mr-2 h-4 w-4" />
									Join as server
									<span className="ml-2 text-xs text-muted-foreground">
										adds HA raft
									</span>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</CardHeader>
			<CardContent>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="nomadAddress"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Nomad Address</FormLabel>
									<FormControl>
										<Input
											placeholder="http://nomad.example.com:4646"
											{...field}
										/>
									</FormControl>
									<FormDescription>
										The HTTP address of your Nomad cluster.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="nomadToken"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Nomad Token</FormLabel>
									<FormControl>
										<Input
											type="password"
											placeholder="ACL token (optional)"
											{...field}
										/>
									</FormControl>
									<FormDescription>
										ACL token for authenticating with Nomad.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="nomadNamespace"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Namespace</FormLabel>
									<FormControl>
										<Input placeholder="default" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="registryUrl"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Docker Registry URL</FormLabel>
									<FormControl>
										<Input placeholder="registry.example.com" {...field} />
									</FormControl>
									<FormDescription>
										Registry where images are pushed for Nomad to pull.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<Button type="submit" disabled={isPending}>
							{isPending ? "Saving..." : "Save"}
						</Button>
					</form>
				</Form>

				{(isBootstrapping || bootstrapLogs) && (
					<pre className="mt-4 max-h-[400px] overflow-auto whitespace-pre-wrap rounded-lg bg-black p-4 font-mono text-xs text-green-400">
						{bootstrapLogs || "Starting bootstrap…"}
					</pre>
				)}
				{(isJoining || joinLogs) && (
					<pre className="mt-4 max-h-[400px] overflow-auto whitespace-pre-wrap rounded-lg bg-black p-4 font-mono text-xs text-green-400">
						{joinLogs || "Joining cluster…"}
					</pre>
				)}
				{(isLeaving || leaveLogs) && (
					<pre className="mt-4 max-h-[400px] overflow-auto whitespace-pre-wrap rounded-lg bg-black p-4 font-mono text-xs text-green-400">
						{leaveLogs || "Removing node…"}
					</pre>
				)}

				<div className="mt-8">
					<div className="mb-2 flex items-center justify-between">
						<div>
							<h3 className="font-medium text-sm">Cluster members</h3>
							<p className="text-muted-foreground text-xs">
								Nomad/Consul servers and worker nodes on the WireGuard overlay.
							</p>
						</div>
						<div className="flex items-center gap-2">
							{serverCount > 0 && (
								<Badge
									variant={faultTolerance > 0 ? "default" : "outline"}
									title="How many servers can fail while the cluster keeps a quorum"
								>
									{serverCount} server{serverCount === 1 ? "" : "s"} · fault
									tolerance {faultTolerance}
								</Badge>
							)}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => refetchMembers()}
								disabled={isRefetchingMembers}
							>
								<RefreshCw
									className={`h-4 w-4 ${isRefetchingMembers ? "animate-spin" : ""}`}
								/>
							</Button>
						</div>
					</div>
					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Role</TableHead>
									<TableHead>Overlay IP</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{members && members.length > 0 ? (
									members.map((m) => (
										<TableRow key={`${m.role}-${m.wgIp}`}>
											<TableCell className="font-medium">
												{m.name}
												{m.leader && (
													<Badge variant="outline" className="ml-2">
														leader
													</Badge>
												)}
												{m.serverId === serverId && (
													<span className="ml-2 text-muted-foreground text-xs">
														(this server)
													</span>
												)}
											</TableCell>
											<TableCell>
												<Badge
													variant={
														m.role === "server" ? "default" : "secondary"
													}
												>
													{m.role}
												</Badge>
											</TableCell>
											<TableCell className="font-mono text-xs">
												{m.wgIp}
											</TableCell>
											<TableCell>
												<Badge
													variant={
														m.status === "ready"
															? "default"
															: m.status === "unknown"
																? "outline"
																: "destructive"
													}
												>
													{m.status}
												</Badge>
											</TableCell>
											<TableCell className="text-right">
												{m.serverId ? (
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="text-destructive hover:text-destructive"
														disabled={busy}
														onClick={() =>
															openRemove({
																serverId: m.serverId as string,
																name: m.name,
																role: m.role as ClusterRole,
															})
														}
													>
														<Trash2 className="h-4 w-4" />
													</Button>
												) : (
													<span className="text-muted-foreground text-xs">
														hub
													</span>
												)}
											</TableCell>
										</TableRow>
									))
								) : (
									<TableRow>
										<TableCell
											colSpan={5}
											className="text-center text-muted-foreground text-sm"
										>
											No cluster members yet.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
				</div>
				<AlertDialog
					open={!!removeTarget}
					onOpenChange={(o) => {
						if (!o) setRemoveTarget(null);
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								Remove “{removeTarget?.name}” from the cluster?
							</AlertDialogTitle>
							<AlertDialogDescription asChild>
								<div className="space-y-3">
									<p>
										The node is drained, its services stopped, and its WireGuard
										peer removed from every remaining member. Its overlay IP is
										freed for reuse.
									</p>
									{removeTarget?.role === "server" && (
										<div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
											<p className="font-medium">
												This is a Nomad/Consul server (raft member).
											</p>
											<p className="mt-1">
												Removing it shrinks the raft. Below 3 servers the
												cluster loses fault tolerance; the last server cannot be
												removed. Enable force to proceed anyway.
											</p>
											<label
												htmlFor="force-leave"
												className="mt-2 flex items-center gap-2"
											>
												<Checkbox
													id="force-leave"
													checked={forceLeave}
													onCheckedChange={(v) => setForceLeave(v === true)}
												/>
												<span>Force (drop below 3 servers)</span>
											</label>
										</div>
									)}
								</div>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={startLeave}
								className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
							>
								Remove node
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</CardContent>
		</Card>
	);
};
