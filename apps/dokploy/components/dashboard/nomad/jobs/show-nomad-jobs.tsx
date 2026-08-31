import { AlertTriangle, Loader2, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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

export const ShowNomadJobs = () => {
	const {
		data: jobs,
		isLoading,
		isError,
		refetch,
	} = api.nomad.getJobs.useQuery();

	const stopJob = api.nomad.stopJob.useMutation({
		onSuccess: () => {
			toast.success("Job stopped");
			refetch();
		},
		onError: (e) => toast.error(e.message),
	});

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
					Failed to connect to Nomad. Is it running?
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<Card className="bg-sidebar rounded-xl">
			<CardHeader className="flex flex-row items-center justify-between">
				<CardTitle className="text-xl">Nomad Jobs</CardTitle>
				<Button variant="ghost" size="icon" onClick={() => refetch()}>
					<RefreshCw className="h-4 w-4" />
				</Button>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Type</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Task Groups</TableHead>
							<TableHead>Actions</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{jobs?.map((job: any) => (
							<TableRow key={job.ID}>
								<TableCell className="font-medium">{job.Name}</TableCell>
								<TableCell>
									<Badge variant="outline">{job.Type}</Badge>
								</TableCell>
								<TableCell>
									<StatusBadge status={job.Status} />
								</TableCell>
								<TableCell>
									{job.JobSummary?.Summary &&
										Object.entries(job.JobSummary.Summary).map(
											([group, summary]: [string, any]) => (
												<div key={group} className="text-sm">
													{group}: {summary.Running}/{summary.Running + summary.Starting + summary.Queued} running
												</div>
											),
										)}
								</TableCell>
								<TableCell>
									<div className="flex gap-1">
										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button variant="ghost" size="icon" title="Stop">
													<Square className="h-4 w-4" />
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>Stop job "{job.Name}"?</AlertDialogTitle>
													<AlertDialogDescription>
														This will stop all allocations for this job. You can restart it later.
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>Cancel</AlertDialogCancel>
													<AlertDialogAction
														onClick={() => stopJob.mutate({ jobId: job.ID, purge: false })}
													>
														Stop
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>

										<AlertDialog>
											<AlertDialogTrigger asChild>
												<Button variant="ghost" size="icon" title="Purge">
													<Trash2 className="h-4 w-4 text-destructive" />
												</Button>
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>Purge job "{job.Name}"?</AlertDialogTitle>
													<AlertDialogDescription>
														This will permanently remove the job and all its history. This cannot be undone.
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>Cancel</AlertDialogCancel>
													<AlertDialogAction
														className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
														onClick={() => stopJob.mutate({ jobId: job.ID, purge: true })}
													>
														Purge
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									</div>
								</TableCell>
							</TableRow>
						))}
						{(!jobs || jobs.length === 0) && (
							<TableRow>
								<TableCell colSpan={5} className="text-center text-muted-foreground">
									No jobs running
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
};

const StatusBadge = ({ status }: { status: string }) => {
	const variant =
		status === "running"
			? "default"
			: status === "dead"
				? "destructive"
				: "secondary";

	return <Badge variant={variant}>{status}</Badge>;
};
