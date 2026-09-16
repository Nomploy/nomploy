import { Activity } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

interface Props {
	serverId?: string;
}

const PER_PAGE = 10;

/**
 * Cluster-wide SERVICE scaling: each service's current vs desired replicas and a
 * paginated feed of replica scale events (Nomad Autoscaler actions or manual scales),
 * newest first. Distinct from the node-autoscaling groups above (which add/remove VMs).
 */
export const ShowServiceScaling = ({ serverId }: Props) => {
	const [page, setPage] = useState(0);
	const { data } = api.nomad.getServiceScalingActivity.useQuery(
		{ serverId, limit: PER_PAGE, offset: page * PER_PAGE },
		{ refetchInterval: 15000 },
	);
	const services = data?.services ?? [];
	const events = data?.events ?? [];

	return (
		<div className="space-y-4">
			<Card className="bg-sidebar rounded-xl">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-lg">
						<Activity className="size-4" /> Service scaling
					</CardTitle>
					<CardDescription>
						Per-service replica counts and scaling activity (the Nomad
						Autoscaler driving a service's scaling policy, or manual scales).
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Service</TableHead>
									<TableHead className="w-[110px]">Group</TableHead>
									<TableHead className="w-[130px]">Running / Desired</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{services.length > 0 ? (
									services.map((s) => (
										<TableRow key={`${s.jobId}-${s.group}`}>
											<TableCell className="font-mono text-xs">
												{s.jobId}
											</TableCell>
											<TableCell className="text-sm">{s.group}</TableCell>
											<TableCell className="text-sm">
												{s.running}/{s.desired}
											</TableCell>
										</TableRow>
									))
								) : (
									<TableRow>
										<TableCell
											colSpan={3}
											className="text-center text-muted-foreground text-sm"
										>
											No services running.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>

					<div>
						<p className="mb-2 font-medium text-sm">Activity</p>
						<div className="rounded-lg border">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="w-[170px]">When</TableHead>
										<TableHead>Service</TableHead>
										<TableHead className="w-[110px]">Change</TableHead>
										<TableHead>Reason</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{events.length > 0 ? (
										events.map((e, i) => (
											<TableRow key={`${e.jobId}-${e.time}-${i}`}>
												<TableCell className="text-muted-foreground text-xs">
													{e.time
														? new Date(e.time / 1e6).toLocaleString()
														: "—"}
												</TableCell>
												<TableCell className="font-mono text-xs">
													{e.jobId}
													<span className="text-muted-foreground">
														{" "}
														/ {e.group}
													</span>
												</TableCell>
												<TableCell>
													<Badge
														variant={
															e.error
																? "destructive"
																: (e.count ?? 0) > (e.previousCount ?? 0)
																	? "default"
																	: "secondary"
														}
													>
														{e.previousCount ?? "?"} → {e.count ?? "?"}
													</Badge>
												</TableCell>
												<TableCell className="text-sm">
													{e.message}
													{e.error && (
														<span className="ml-1 text-destructive text-xs">
															{e.error}
														</span>
													)}
												</TableCell>
											</TableRow>
										))
									) : (
										<TableRow>
											<TableCell
												colSpan={4}
												className="text-center text-muted-foreground text-sm"
											>
												No scaling activity yet.
											</TableCell>
										</TableRow>
									)}
								</TableBody>
							</Table>
						</div>
						{(page > 0 || data?.hasMore) && (
							<div className="mt-3 flex items-center justify-between">
								<span className="text-muted-foreground text-xs">
									Page {page + 1}
								</span>
								<div className="flex gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={page === 0}
										onClick={() => setPage((p) => Math.max(0, p - 1))}
									>
										Previous
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={!data?.hasMore}
										onClick={() => setPage((p) => p + 1)}
									>
										Next
									</Button>
								</div>
							</div>
						)}
					</div>
				</CardContent>
			</Card>
		</div>
	);
};
