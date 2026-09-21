import {
	AlertTriangle,
	ArrowUpCircle,
	CheckCircle2,
	Copy,
	Crown,
	Loader2,
	PackageCheck,
} from "lucide-react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

interface VersionNode {
	name: string;
	status: string;
	nomadVersion: string | null;
	consulVersion: string | null;
	role: "server" | "worker";
	isLeader: boolean;
	serverId: string | null;
	isControlPlane?: boolean;
}

// The control-plane hub runs the panel inside a container without host apt/systemd
// access, so the panel can't upgrade the host's Nomad for it. Surface the exact
// manual step instead of a dead "manual" label. `systemctl restart nomad` does a
// graceful raft leadership handoff, so it's safe to run even when the hub is leader.
const CONTROL_PLANE_UPGRADE_CMD =
	"apt-get update -qq && apt-get install -y --only-upgrade nomad && systemctl restart nomad";

const ManualUpgrade = ({ node }: { node: VersionNode }) => (
	<Dialog>
		<DialogTrigger asChild>
			<Button size="sm" variant="outline">
				<ArrowUpCircle className="mr-2 h-3.5 w-3.5" />
				Upgrade manually
			</Button>
		</DialogTrigger>
		<DialogContent>
			<DialogHeader>
				<DialogTitle>Upgrade Nomad on {node.name} (control plane)</DialogTitle>
				<DialogDescription>
					The control plane runs the panel itself (in a container without host
					access), so the panel can't upgrade its own host from here. Run this
					on <span className="font-mono">{node.name}</span> over SSH — the
					restart hands off raft leadership gracefully and running allocations
					(including this panel) reattach, so there's no downtime.
				</DialogDescription>
			</DialogHeader>
			<div className="break-all rounded-md bg-muted p-3 font-mono text-xs">
				{CONTROL_PLANE_UPGRADE_CMD}
			</div>
			<DialogFooter>
				<Button
					variant="outline"
					onClick={() =>
						navigator.clipboard
							?.writeText(CONTROL_PLANE_UPGRADE_CMD)
							.then(() => toast.success("Command copied"))
							.catch(() => {})
					}
				>
					<Copy className="mr-2 h-3.5 w-3.5" />
					Copy command
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
);

/**
 * Cluster version visibility + upgrade readiness. Shows each node's Nomad/Consul
 * version, flags version skew and whether a newer Nomad is available, and lays
 * out the quorum-safe order to upgrade. Upgrades themselves stay a guided,
 * one-node-at-a-time operation (drain → upgrade the package → let it rejoin) so
 * raft quorum is never lost — not a blind cluster-wide sweep.
 */
export const ShowClusterUpgrade = ({ serverId }: { serverId?: string }) => {
	const { data, isLoading, refetch } = api.nomad.getClusterVersions.useQuery(
		{ serverId },
		{ refetchInterval: 30000 },
	);
	const upgrade = api.nomad.upgradeNode.useMutation();

	if (isLoading || !data) {
		return (
			<Card className="bg-sidebar rounded-xl">
				<CardContent className="flex items-center justify-center p-8">
					<Loader2 className="h-6 w-6 animate-spin" />
				</CardContent>
			</Card>
		);
	}

	const nodes = data.nodes as VersionNode[];
	const latest = data.latestNomad;

	const needsUpdate = (v: string | null) => !!latest && !!v && v !== latest;

	// Quorum-safe order: workers first (drain, order-independent), then server
	// followers one at a time, leader last. Role + leader come from the endpoint.
	const workers = nodes.filter((n) => n.role === "worker");
	const servers = nodes.filter((n) => n.role === "server");
	const serverFollowers = servers.filter((n) => !n.isLeader);
	const leader = servers.find((n) => n.isLeader);

	// The single node whose upgrade is enabled right now: the first still-outdated,
	// panel-upgradable node in quorum order. Everything after it waits; the hub
	// (no serverId) is skipped (manual). Enforces one-at-a-time, leader last.
	const ordered = [...workers, ...serverFollowers, ...(leader ? [leader] : [])];
	const nextTarget = ordered.find(
		(n) => n.serverId && needsUpdate(n.nomadVersion),
	);

	const runUpgrade = async (node: VersionNode) => {
		if (!node.serverId) return;
		try {
			const res = await upgrade.mutateAsync({ serverId: node.serverId });
			toast.success(
				res.changed
					? `${node.name} upgraded — agent restarted`
					: `${node.name}: already up to date (no restart)`,
			);
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Upgrade failed");
		}
	};

	return (
		<Card className="bg-sidebar rounded-xl">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<PackageCheck className="size-5 text-sky-500" />
					Cluster Version &amp; Upgrade
				</CardTitle>
				<div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
					<span className="text-muted-foreground">Latest Nomad:</span>
					<Badge variant="outline">{latest ?? "unknown"}</Badge>
					{data.upToDate ? (
						<Badge className="gap-1">
							<CheckCircle2 className="h-3.5 w-3.5" /> up to date
						</Badge>
					) : latest ? (
						<Badge variant="secondary" className="gap-1">
							<ArrowUpCircle className="h-3.5 w-3.5" /> update available
						</Badge>
					) : null}
					{data.skew && (
						<Badge variant="destructive" className="gap-1">
							<AlertTriangle className="h-3.5 w-3.5" /> version skew
						</Badge>
					)}
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="overflow-x-auto">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Node</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Nomad</TableHead>
								<TableHead>Consul</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="text-right">Upgrade</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{nodes.map((n) => {
								const outdated = needsUpdate(n.nomadVersion);
								const isNext = nextTarget?.name === n.name;
								return (
									<TableRow key={n.name}>
										<TableCell className="font-medium">
											<span className="flex items-center gap-1.5">
												{n.isLeader && (
													<Crown className="h-3.5 w-3.5 text-primary" />
												)}
												{n.name}
											</span>
										</TableCell>
										<TableCell className="text-muted-foreground">
											{n.role}
										</TableCell>
										<TableCell>
											<span className="flex items-center gap-1.5">
												<span className="font-mono">
													{n.nomadVersion ?? "—"}
												</span>
												{needsUpdate(n.nomadVersion) && (
													<ArrowUpCircle className="h-3.5 w-3.5 text-amber-500" />
												)}
											</span>
										</TableCell>
										<TableCell className="font-mono text-muted-foreground">
											{n.consulVersion ?? "—"}
										</TableCell>
										<TableCell>
											<Badge
												variant={
													n.status === "ready" ? "default" : "destructive"
												}
											>
												{n.status}
											</Badge>
										</TableCell>
										<TableCell className="text-right">
											{!outdated ? (
												<span className="text-xs text-muted-foreground">
													up to date
												</span>
											) : !n.serverId ? (
												<ManualUpgrade node={n} />
											) : isNext ? (
												<DialogAction
													title={`Upgrade Nomad on ${n.name}?`}
													description={
														n.role === "server"
															? "apt upgrades the package and restarts the Nomad agent. Running allocations keep running; raft rejoins after restart. Wait for it to rejoin before the next node."
															: "apt upgrades the package and restarts the Nomad agent. Running allocations on this worker keep running and reconnect after restart."
													}
													type="default"
													onClick={() => runUpgrade(n)}
												>
													<Button
														size="sm"
														variant="outline"
														disabled={upgrade.isPending}
													>
														{upgrade.isPending ? (
															<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
														) : (
															<ArrowUpCircle className="mr-2 h-3.5 w-3.5" />
														)}
														Upgrade
													</Button>
												</DialogAction>
											) : (
												<span className="text-xs text-muted-foreground">
													{n.isLeader ? "leader — last" : "waiting"}
												</span>
											)}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>

				{(data.skew || (!data.upToDate && latest)) && (
					<div className="space-y-2">
						<AlertBlock type="info">
							Use the Upgrade buttons one node at a time — they're enabled in
							quorum-safe order so raft is never lost. Each upgrades the Nomad
							package over SSH and restarts the agent only if it actually
							changed (running allocations keep running). The control-plane hub
							has no server record, so upgrade it manually (
							<span className="font-mono">apt-get install nomad</span> on the
							hub).
						</AlertBlock>
						<div className="text-sm">
							<p className="font-medium mb-1">Quorum-safe order</p>
							<ol className="list-decimal pl-5 space-y-0.5 text-muted-foreground">
								{workers.length > 0 && (
									<li>
										Workers (drain → upgrade → un-drain):{" "}
										<span className="font-mono">
											{workers.map((w) => w.name).join(", ")}
										</span>
									</li>
								)}
								{serverFollowers.length > 0 && (
									<li>
										Server followers, one at a time:{" "}
										<span className="font-mono">
											{serverFollowers.map((s) => s.name).join(", ")}
										</span>
									</li>
								)}
								{leader && (
									<li>
										Leader last (it steps down on restart):{" "}
										<span className="font-mono">{leader.name}</span>
									</li>
								)}
							</ol>
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
};
