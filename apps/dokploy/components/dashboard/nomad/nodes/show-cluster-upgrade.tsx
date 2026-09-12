import {
	AlertTriangle,
	ArrowUpCircle,
	CheckCircle2,
	Crown,
	Loader2,
	PackageCheck,
} from "lucide-react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
}
interface Member {
	name: string;
	role: "server" | "worker";
	isLeader?: boolean;
}

/**
 * Cluster version visibility + upgrade readiness. Shows each node's Nomad/Consul
 * version, flags version skew and whether a newer Nomad is available, and lays
 * out the quorum-safe order to upgrade. Upgrades themselves stay a guided,
 * one-node-at-a-time operation (drain → upgrade the package → let it rejoin) so
 * raft quorum is never lost — not a blind cluster-wide sweep.
 */
export const ShowClusterUpgrade = ({ serverId }: { serverId?: string }) => {
	const { data, isLoading } = api.nomad.getClusterVersions.useQuery(
		{ serverId },
		{ refetchInterval: 30000 },
	);
	const { data: membersRaw } = api.nomad.getClusterMembers.useQuery(undefined, {
		refetchOnWindowFocus: false,
	});

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
	const members = (membersRaw ?? []) as Member[];
	const roleOf = new Map(members.map((m) => [m.name, m]));
	const latest = data.latestNomad;

	const needsUpdate = (v: string | null) => !!latest && !!v && v !== latest;

	// Quorum-safe order: workers first (drain, order-independent), then server
	// followers one at a time, leader last.
	const workers = nodes.filter((n) => roleOf.get(n.name)?.role === "worker");
	const servers = nodes.filter((n) => roleOf.get(n.name)?.role !== "worker");
	const serverFollowers = servers.filter((n) => !roleOf.get(n.name)?.isLeader);
	const leader = servers.find((n) => roleOf.get(n.name)?.isLeader);

	return (
		<Card className="bg-sidebar rounded-xl">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<PackageCheck className="size-5" />
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
							</TableRow>
						</TableHeader>
						<TableBody>
							{nodes.map((n) => {
								const m = roleOf.get(n.name);
								return (
									<TableRow key={n.name}>
										<TableCell className="font-medium">
											<span className="flex items-center gap-1.5">
												{m?.isLeader && (
													<Crown className="h-3.5 w-3.5 text-primary" />
												)}
												{n.name}
											</span>
										</TableCell>
										<TableCell className="text-muted-foreground">
											{m?.role ?? "—"}
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
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>

				{(data.skew || (!data.upToDate && latest)) && (
					<div className="space-y-2">
						<AlertBlock type="info">
							Upgrade one node at a time so raft quorum is never lost. From each
							node's settings: drain it (Maintenance), upgrade the Nomad package
							(<span className="font-mono">apt-get install nomad</span>), and
							let it rejoin before moving on.
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
