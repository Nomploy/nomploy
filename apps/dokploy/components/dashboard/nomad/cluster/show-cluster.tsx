import {
	CloudCog,
	Crown,
	Loader2,
	Network,
	Plus,
	RefreshCw,
	ServerCog,
	Server as ServerIcon,
	ShieldAlert,
	ShieldCheck,
	Trash2,
	Zap,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
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
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";

type ClusterRole = "server" | "worker";

// Must match OP_ENDED in the nomad router — streamed on any non-success end.
const OP_ENDED = "OP_ENDED";

const SOURCE_LABEL: Record<string, { label: string; hint: string }> = {
	"control-plane": {
		label: "control plane",
		hint: "The panel + database host",
	},
	autoscaled: { label: "autoscaled", hint: "Provisioned by the autoscaler" },
	provisioned: { label: "cloud", hint: "One-click cloud VM" },
	manual: { label: "manual", hint: "Added by hand over SSH" },
};

const LogTerminal = ({
	logs,
	fallback,
}: {
	logs: string;
	fallback: string;
}) => (
	<pre className="mt-4 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg bg-black p-4 font-mono text-xs text-green-400">
		{logs || fallback}
	</pre>
);

const Stat = ({
	icon,
	label,
	value,
	sub,
	accent,
}: {
	icon: React.ReactNode;
	label: string;
	value: React.ReactNode;
	sub?: string;
	accent?: boolean;
}) => (
	<div className="flex flex-col gap-1 rounded-lg border bg-background p-4">
		<div className="flex items-center gap-2 text-muted-foreground text-xs">
			{icon}
			{label}
		</div>
		<div
			className={`font-semibold text-2xl tabular-nums ${accent ? "text-primary" : ""}`}
		>
			{value}
		</div>
		{sub && <div className="text-muted-foreground text-xs">{sub}</div>}
	</div>
);

export const ShowCluster = () => {
	const {
		data: members,
		refetch: refetchMembers,
		isRefetching,
	} = api.nomad.getClusterMembers.useQuery(undefined, {
		refetchOnWindowFocus: false,
		refetchInterval: 20000,
	});
	const { data: autoscaler } = api.nomad.getAutoscalerConfig.useQuery();

	// One-click cloud provisioning is available only once a provider token + SSH
	// key are configured (in the Autoscaling tab).
	const canProvision = !!autoscaler?.hasToken && !!autoscaler?.sshKeyId;
	const provider = autoscaler?.provider ?? "hetzner";

	const [provisionRole, setProvisionRole] = useState<ClusterRole>("worker");
	const [isProvisioning, setIsProvisioning] = useState(false);
	const [provisionLogs, setProvisionLogs] = useState("");

	api.nomad.provisionAndJoin.useSubscription(
		{ role: provisionRole },
		{
			enabled: isProvisioning,
			onData(log) {
				if (log === "PROVISION_DONE") {
					setIsProvisioning(false);
					toast.success(
						`New ${provisionRole} provisioned and joined the cluster`,
					);
					refetchMembers();
					return;
				}
				if (log.includes(OP_ENDED)) {
					setIsProvisioning(false);
					return;
				}
				setProvisionLogs((prev) => prev + log);
			},
			onError(error) {
				setIsProvisioning(false);
				toast.error(error.message || "Provisioning failed");
			},
		},
	);

	const startProvision = (role: ClusterRole) => {
		setProvisionRole(role);
		setProvisionLogs("");
		setIsProvisioning(true);
	};

	// Removal (drain + leave + WireGuard peer removal; destroys the cloud VM for
	// nodes that have one).
	const [removeTarget, setRemoveTarget] = useState<{
		serverId: string;
		name: string;
		role: ClusterRole;
		hasVm: boolean;
	} | null>(null);
	const [forceLeave, setForceLeave] = useState(false);
	const [isLeaving, setIsLeaving] = useState(false);
	const [leaveLogs, setLeaveLogs] = useState("");

	api.nomad.removeNode.useSubscription(
		{ serverId: removeTarget?.serverId ?? "", force: forceLeave },
		{
			enabled: isLeaving && !!removeTarget,
			onData(log) {
				if (log === "REMOVE_DONE") {
					setIsLeaving(false);
					setRemoveTarget(null);
					toast.success("Node removed from the cluster");
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
				toast.error(error.message || "Removal failed");
			},
		},
	);

	// Add an existing (bring-your-own) server to the cluster. joinCluster is
	// self-contained — it installs Docker/Consul/Nomad/CNI/WireGuard over SSH and
	// joins — so this just needs a registered server that isn't a member yet.
	const { data: servers } = api.server.all.useQuery();
	const candidates = (servers ?? []).filter((s) => !s.clusterRole);
	const [byoOpen, setByoOpen] = useState(false);
	const [byoServerId, setByoServerId] = useState("");
	const [byoRole, setByoRole] = useState<ClusterRole>("worker");
	const [isJoining, setIsJoining] = useState(false);
	const [joinLogs, setJoinLogs] = useState("");

	api.nomad.joinCluster.useSubscription(
		{ serverId: byoServerId, role: byoRole },
		{
			enabled: isJoining && !!byoServerId,
			onData(log) {
				if (log === "JOIN_DONE") {
					setIsJoining(false);
					setByoOpen(false);
					toast.success(`Server joined the cluster as ${byoRole}`);
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
				toast.error(error.message || "Join failed");
			},
		},
	);

	const busy = isProvisioning || isLeaving || isJoining;
	const serverCount = members?.filter((m) => m.role === "server").length ?? 0;
	const workerCount = members?.filter((m) => m.role === "worker").length ?? 0;
	// Raft fault tolerance: how many servers can fail while keeping quorum.
	const faultTolerance = Math.max(0, Math.floor((serverCount - 1) / 2));
	const isHA = serverCount >= 3 && faultTolerance >= 1;
	const leader = members?.find((m) => m.leader);
	const serversToHA = Math.max(0, 3 - serverCount);

	return (
		<div className="space-y-6">
			{/* HA status hero */}
			<Card
				className={
					isHA
						? "border-emerald-500/40 bg-emerald-500/5"
						: "border-amber-500/40 bg-amber-500/5"
				}
			>
				<CardContent className="pt-6">
					<div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
						<div className="flex items-start gap-4">
							{isHA ? (
								<ShieldCheck className="mt-0.5 h-10 w-10 shrink-0 text-emerald-500" />
							) : (
								<ShieldAlert className="mt-0.5 h-10 w-10 shrink-0 text-amber-500" />
							)}
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<h2 className="font-semibold text-xl">
										{isHA ? "Highly available" : "Not highly available"}
									</h2>
									<Badge
										variant={isHA ? "default" : "outline"}
										className={
											isHA
												? "bg-emerald-500 text-white hover:bg-emerald-500"
												: "border-amber-500/50 text-amber-600"
										}
									>
										{isHA ? "HA" : "Single point of failure"}
									</Badge>
								</div>
								<p className="max-w-xl text-muted-foreground text-sm">
									{isHA
										? `The control plane runs on ${serverCount} Nomad/Consul servers. Scheduling survives up to ${faultTolerance} simultaneous server failure${faultTolerance === 1 ? "" : "s"}.`
										: serverCount <= 1
											? "Scheduling runs on a single server. If it goes down, nothing schedules. Add servers to form a fault-tolerant raft."
											: `${serverCount} servers is short of a fault-tolerant quorum. Add ${serversToHA} more server${serversToHA === 1 ? "" : "s"} to reach HA.`}
								</p>
							</div>
						</div>
						{!isHA && (
							<Button
								onClick={() => startProvision("server")}
								disabled={busy || !canProvision}
								className="shrink-0"
							>
								{isProvisioning && provisionRole === "server" ? (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								) : (
									<Zap className="mr-2 h-4 w-4" />
								)}
								Add {serversToHA} server{serversToHA === 1 ? "" : "s"} for HA
							</Button>
						)}
					</div>
					<div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
						<Stat
							icon={<ServerIcon className="h-3.5 w-3.5" />}
							label="Servers"
							value={serverCount}
							sub="Nomad/Consul raft"
						/>
						<Stat
							icon={<Network className="h-3.5 w-3.5" />}
							label="Workers"
							value={workerCount}
							sub="run workloads"
						/>
						<Stat
							icon={<ShieldCheck className="h-3.5 w-3.5" />}
							label="Fault tolerance"
							value={faultTolerance}
							sub={faultTolerance ? "servers can fail" : "no redundancy"}
							accent={faultTolerance > 0}
						/>
						<Stat
							icon={<Crown className="h-3.5 w-3.5" />}
							label="Raft leader"
							value={
								<span className="truncate text-base">
									{leader?.name ?? "—"}
								</span>
							}
							sub={leader?.wgIp}
						/>
					</div>
				</CardContent>
			</Card>

			{/* Members + one-click add */}
			<Card className="bg-background">
				<CardContent className="pt-6">
					<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
						<div>
							<h3 className="font-medium text-sm">Cluster members</h3>
							<p className="text-muted-foreground text-xs">
								Nomad/Consul servers and workers on the WireGuard overlay.
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => refetchMembers()}
								disabled={isRefetching}
							>
								<RefreshCw
									className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`}
								/>
							</Button>
							<Button
								type="button"
								variant="outline"
								disabled={busy || candidates.length === 0}
								title={
									candidates.length === 0
										? "No registered servers left to add — create one under Settings → Servers"
										: "Join a server you've already added to nomploy"
								}
								onClick={() => {
									setByoServerId(candidates[0]?.serverId ?? "");
									setByoRole("worker");
									setJoinLogs("");
									setByoOpen(true);
								}}
							>
								<ServerCog className="mr-2 h-4 w-4" />
								Add existing server
							</Button>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										{/* span wrapper so the tooltip still fires when disabled */}
										<span>
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<Button
														type="button"
														disabled={busy || !canProvision}
													>
														{isProvisioning ? (
															<Loader2 className="mr-2 h-4 w-4 animate-spin" />
														) : (
															<Plus className="mr-2 h-4 w-4" />
														)}
														{isProvisioning ? "Provisioning…" : "Add node"}
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end" className="w-64">
													<DropdownMenuLabel className="flex items-center gap-2">
														<CloudCog className="h-3.5 w-3.5" />
														One-click on {provider}
													</DropdownMenuLabel>
													<DropdownMenuSeparator />
													<DropdownMenuItem
														onClick={() => startProvision("worker")}
													>
														<Network className="mr-2 h-4 w-4" />
														<div className="flex flex-col">
															<span>Add worker node</span>
															<span className="text-muted-foreground text-xs">
																more capacity for workloads
															</span>
														</div>
													</DropdownMenuItem>
													<DropdownMenuItem
														onClick={() => startProvision("server")}
													>
														<ServerIcon className="mr-2 h-4 w-4" />
														<div className="flex flex-col">
															<span>Add server node</span>
															<span className="text-muted-foreground text-xs">
																grows the HA raft
															</span>
														</div>
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</span>
									</TooltipTrigger>
									{!canProvision && (
										<TooltipContent className="max-w-xs">
											Set a cloud provider token and SSH key in the{" "}
											<Link
												href="?tab=autoscale"
												className="underline underline-offset-2"
											>
												Autoscaling tab
											</Link>{" "}
											to enable one-click node provisioning.
										</TooltipContent>
									)}
								</Tooltip>
							</TooltipProvider>
						</div>
					</div>

					{!canProvision && (
						<div className="mb-4 rounded-md border border-dashed p-3 text-muted-foreground text-xs">
							💡 Add a {provider} API token + SSH key in the{" "}
							<span className="font-medium text-foreground">Autoscaling</span>{" "}
							tab to spin up and join new nodes with one click. You can also add
							existing servers by hand from{" "}
							<span className="font-medium text-foreground">
								Settings → Servers → Nomad
							</span>
							.
						</div>
					)}

					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Role</TableHead>
									<TableHead>Source</TableHead>
									<TableHead>Overlay IP</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{members && members.length > 0 ? (
									members.map((m) => {
										const src = SOURCE_LABEL[m.source] ?? {
											label: m.source,
											hint: "",
										};
										return (
											<TableRow key={`${m.role}-${m.wgIp}`}>
												<TableCell className="font-medium">
													{m.name}
													{m.leader && (
														<Badge variant="outline" className="ml-2 gap-1">
															<Crown className="h-3 w-3" />
															leader
														</Badge>
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
												<TableCell>
													<span
														className="text-muted-foreground text-xs"
														title={src.hint}
													>
														{src.label}
													</span>
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
															onClick={() => {
																setForceLeave(false);
																setLeaveLogs("");
																setRemoveTarget({
																	serverId: m.serverId as string,
																	name: m.name,
																	role: m.role as ClusterRole,
																	hasVm: m.hasVm,
																});
															}}
														>
															<Trash2 className="h-4 w-4" />
														</Button>
													) : (
														<span className="text-muted-foreground text-xs">
															control plane
														</span>
													)}
												</TableCell>
											</TableRow>
										);
									})
								) : (
									<TableRow>
										<TableCell
											colSpan={6}
											className="text-center text-muted-foreground text-sm"
										>
											No cluster members yet.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>

					{(isProvisioning || provisionLogs) && (
						<LogTerminal
							logs={provisionLogs}
							fallback={`Provisioning a new ${provisionRole} on ${provider}…`}
						/>
					)}
					{(isLeaving || leaveLogs) && (
						<LogTerminal logs={leaveLogs} fallback="Removing node…" />
					)}
				</CardContent>
			</Card>

			<AlertDialog
				open={!!removeTarget}
				onOpenChange={(o) => {
					if (!o && !isLeaving) setRemoveTarget(null);
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
									peer removed from every remaining member.
								</p>
								{removeTarget?.hasVm && (
									<div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
										This node runs on a cloud VM — the VM will be{" "}
										<span className="font-medium">permanently destroyed</span>{" "}
										so it stops billing.
									</div>
								)}
								{removeTarget?.role === "server" && (
									<div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
										<p className="font-medium">
											This is a Nomad/Consul server (raft member).
										</p>
										<p className="mt-1">
											Removing it shrinks the raft. Below 3 servers the cluster
											loses fault tolerance; the last server cannot be removed.
										</p>
										<label
											htmlFor="force-leave-cluster"
											className="mt-2 flex items-center gap-2"
										>
											<Checkbox
												id="force-leave-cluster"
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
						<AlertDialogCancel disabled={isLeaving}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={isLeaving}
							onClick={(e) => {
								e.preventDefault();
								setLeaveLogs("");
								setIsLeaving(true);
							}}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{isLeaving ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : null}
							Remove node
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Add an existing (bring-your-own) server to the cluster */}
			<Dialog
				open={byoOpen}
				onOpenChange={(o) => {
					if (!o && !isJoining) setByoOpen(false);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add an existing server</DialogTitle>
						<DialogDescription>
							Join a server you've already registered in nomploy to the cluster.
							It's installed (Docker/Consul/Nomad/WireGuard) and joined over the
							mesh in one step — no cloud provider needed.
						</DialogDescription>
					</DialogHeader>

					{candidates.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							Every registered server is already a cluster member. Add a server
							under Settings → Servers first.
						</p>
					) : (
						<div className="space-y-4">
							<div className="space-y-1.5">
								<Label>Server</Label>
								<Select
									value={byoServerId}
									onValueChange={setByoServerId}
									disabled={isJoining}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select a server" />
									</SelectTrigger>
									<SelectContent>
										{candidates.map((s) => (
											<SelectItem key={s.serverId} value={s.serverId}>
												{s.name}
												<span className="ml-2 text-muted-foreground text-xs">
													{s.ipAddress}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1.5">
								<Label>Role</Label>
								<Select
									value={byoRole}
									onValueChange={(v) => setByoRole(v as ClusterRole)}
									disabled={isJoining}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="worker">
											Worker — runs workloads
										</SelectItem>
										<SelectItem value="server">
											Server — grows the HA raft
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<p className="text-muted-foreground text-xs">
								The server must be SSH-reachable from the control plane. If its
								key isn't authorized yet, the log below prints the exact
								authorized_keys command to run.
							</p>
							{(isJoining || joinLogs) && (
								<LogTerminal logs={joinLogs} fallback="Joining cluster…" />
							)}
						</div>
					)}

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={isJoining}
							onClick={() => setByoOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							disabled={isJoining || !byoServerId || candidates.length === 0}
							onClick={() => {
								setJoinLogs("");
								setIsJoining(true);
							}}
						>
							{isJoining ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<ServerCog className="mr-2 h-4 w-4" />
							)}
							{isJoining ? "Joining…" : "Join cluster"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
};
