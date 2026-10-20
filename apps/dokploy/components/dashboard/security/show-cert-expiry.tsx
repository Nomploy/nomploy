import { formatDistanceToNow } from "date-fns";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

const SOON = 14; // days-left threshold for "expiring soon"

/**
 * TLS certificate expiry for the load balancer pool: every served cert with its
 * domain and days-left, read from the hub's acme.json. Expired certs are flagged
 * red, those expiring within 14 days amber. Lets you catch a renewal that stalled
 * (e.g. a broken DNS-01 / HTTP-01 challenge) before it takes a domain down.
 */
export const ShowCertExpiry = () => {
	const { data: certs, isLoading } = api.nomad.getLoadBalancerCerts.useQuery(
		undefined,
		{ refetchInterval: 300000 },
	);

	if (isLoading) return <Skeleton className="h-48 w-full" />;

	const list = certs ?? [];
	const expired = list.filter((c) => c.daysLeft < 0).length;
	const soon = list.filter((c) => c.daysLeft >= 0 && c.daysLeft < SOON).length;

	return (
		<Card className="bg-background">
			<CardHeader>
				<div className="flex items-center gap-2">
					<ShieldCheck className="size-5 text-muted-foreground" />
					<CardTitle className="text-lg">TLS certificates</CardTitle>
				</div>
				<CardDescription>
					{list.length === 0
						? "No certificates found on the load balancer yet."
						: expired > 0
							? `${expired} expired, ${soon} expiring within ${SOON} days.`
							: soon > 0
								? `${soon} certificate(s) expiring within ${SOON} days.`
								: `${list.length} certificate(s), all renewed in time.`}
				</CardDescription>
			</CardHeader>
			{list.length > 0 && (
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Domain</TableHead>
								<TableHead>Expires</TableHead>
								<TableHead className="text-right">Status</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{list.map((c) => {
								const isExpired = c.daysLeft < 0;
								const isSoon = !isExpired && c.daysLeft < SOON;
								return (
									<TableRow key={c.domain}>
										<TableCell className="font-mono text-sm">
											{c.domain}
										</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{formatDistanceToNow(new Date(c.notAfter), {
												addSuffix: true,
											})}
										</TableCell>
										<TableCell className="text-right">
											{isExpired ? (
												<Badge
													variant="outline"
													className="gap-1 border-destructive/40 text-destructive"
												>
													<ShieldX className="size-3" />
													expired
												</Badge>
											) : isSoon ? (
												<Badge
													variant="outline"
													className="gap-1 border-amber-500/40 text-amber-600"
												>
													<ShieldAlert className="size-3" />
													{c.daysLeft}d left
												</Badge>
											) : (
												<Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600">
													<ShieldCheck className="size-3" />
													{c.daysLeft}d left
												</Badge>
											)}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</CardContent>
			)}
		</Card>
	);
};
