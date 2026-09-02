import {
	AlertTriangle,
	CheckCircle2,
	Loader2,
	Network,
	RefreshCw,
	Server,
	XCircle,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

const HealthBadge = ({
	passing,
	warning,
	critical,
}: {
	passing: number;
	warning: number;
	critical: number;
}) => {
	if (critical > 0) {
		return (
			<Badge variant="destructive" className="gap-1">
				<XCircle className="h-3 w-3" />
				{critical} critical
			</Badge>
		);
	}
	if (warning > 0) {
		return (
			<Badge variant="secondary" className="gap-1">
				<AlertTriangle className="h-3 w-3" />
				{warning} warning
			</Badge>
		);
	}
	return (
		<Badge variant="default" className="gap-1">
			<CheckCircle2 className="h-3 w-3" />
			{passing} passing
		</Badge>
	);
};

export const ShowConsul = ({ serverId }: { serverId?: string }) => {
	const {
		data: services,
		isLoading,
		isError,
		refetch,
	} = api.nomad.getConsulServices.useQuery({ serverId });

	const { data: nodes, refetch: refetchNodes } =
		api.nomad.getConsulNodes.useQuery({ serverId });

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
					Failed to connect to Consul. Is it running?
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<Card className="bg-sidebar rounded-xl">
				<CardHeader className="flex flex-row items-center justify-between">
					<CardTitle className="text-xl">Consul Services</CardTitle>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => {
							refetch();
							refetchNodes();
						}}
					>
						<RefreshCw className="h-4 w-4" />
					</Button>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Service</TableHead>
								<TableHead>Instances</TableHead>
								<TableHead>Health</TableHead>
								<TableHead>Tags</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{services?.map((s) => (
								<TableRow key={s.name}>
									<TableCell className="font-medium">
										<div className="flex items-center gap-2">
											<Network className="h-4 w-4 text-muted-foreground" />
											{s.name}
										</div>
									</TableCell>
									<TableCell>{s.instances}</TableCell>
									<TableCell>
										<HealthBadge
											passing={s.checksPassing}
											warning={s.checksWarning}
											critical={s.checksCritical}
										/>
									</TableCell>
									<TableCell>
										<div className="flex flex-wrap gap-1 max-w-[420px]">
											{s.tags.slice(0, 6).map((t) => (
												<Badge
													key={t}
													variant="outline"
													className="font-mono text-[10px]"
												>
													{t}
												</Badge>
											))}
											{s.tags.length > 6 && (
												<Badge variant="outline" className="text-[10px]">
													+{s.tags.length - 6}
												</Badge>
											)}
										</div>
									</TableCell>
								</TableRow>
							))}
							{(!services || services.length === 0) && (
								<TableRow>
									<TableCell
										colSpan={4}
										className="text-center text-muted-foreground"
									>
										No services registered
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			<Card className="bg-sidebar rounded-xl">
				<CardHeader>
					<CardTitle className="text-xl">Consul Members</CardTitle>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Node</TableHead>
								<TableHead>Address</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Services</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{nodes?.map((n) => (
								<TableRow key={n.node}>
									<TableCell className="font-medium">
										<div className="flex items-center gap-2">
											<Server className="h-4 w-4 text-muted-foreground" />
											{n.node}
										</div>
									</TableCell>
									<TableCell className="font-mono text-xs">
										{n.address}
									</TableCell>
									<TableCell>
										<Badge
											variant={
												n.status === "passing"
													? "default"
													: n.status === "critical"
														? "destructive"
														: "secondary"
											}
										>
											{n.status}
										</Badge>
									</TableCell>
									<TableCell>{n.services}</TableCell>
								</TableRow>
							))}
							{(!nodes || nodes.length === 0) && (
								<TableRow>
									<TableCell
										colSpan={4}
										className="text-center text-muted-foreground"
									>
										No members found
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</CardContent>
			</Card>
		</div>
	);
};
