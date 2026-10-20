import { formatDistanceToNow } from "date-fns";
import { DatabaseBackup, ShieldCheck, ShieldAlert } from "lucide-react";
import { HandleBackup } from "@/components/dashboard/database/backups/handle-backup";
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

// Database types that can be backed up (redis is a cache — no backup path).
const BACKABLE = new Set(["postgres", "mysql", "mariadb", "mongo", "libsql"]);

/**
 * Backup coverage: every backup-able database with its protection status — which
 * have a backup (schedule, destination, last run) and which DON'T, with a one-click
 * "Create Backup" on the unprotected ones (the same dialog as the DB's Backups tab).
 */
export const ShowBackupCoverage = () => {
	const { data: services, isLoading: lo1 } = api.overview.services.useQuery();
	const { data: backups, isLoading: lo2, refetch: refetchBackups } =
		api.overview.backups.useQuery();

	const dbs = (services ?? []).filter((s) => BACKABLE.has(s.type));
	const byService = new Map<string, typeof backups>();
	for (const b of backups ?? []) {
		const arr = byService.get(b.serviceId) ?? [];
		arr.push(b);
		byService.set(b.serviceId, arr);
	}
	const backupIds = (backups ?? []).map((b) => b.backupId);
	const { data: runs } = api.backup.lastRuns.useQuery(
		{ backupIds },
		{ enabled: backupIds.length > 0, refetchInterval: 60000 },
	);

	const refetch = () => refetchBackups();

	if (lo1 || lo2) return <Skeleton className="h-64 w-full" />;

	const protectedCount = dbs.filter(
		(s) => (byService.get(s.id) ?? []).length > 0,
	).length;

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
			<div className="flex items-center gap-2">
				<DatabaseBackup className="size-6 text-muted-foreground" />
				<h1 className="text-2xl font-semibold">Backup coverage</h1>
			</div>
			<p className="text-sm text-muted-foreground">
				{dbs.length === 0
					? "No backup-able databases yet."
					: `${protectedCount} of ${dbs.length} database(s) have a backup configured. Add one to the unprotected ones below.`}
			</p>

			{dbs.length > 0 && (
				<Card className="bg-background">
					<CardHeader>
						<CardTitle className="text-lg">Databases</CardTitle>
						<CardDescription>
							Redis is excluded — it's a cache with no backup path.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Database</TableHead>
									<TableHead>Project</TableHead>
									<TableHead>Backups</TableHead>
									<TableHead>Last run</TableHead>
									<TableHead className="text-right">Status</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{dbs.map((s) => {
									const svcBackups = byService.get(s.id) ?? [];
									const lastRun = svcBackups
										.map((b) => runs?.[b.backupId])
										.filter(Boolean)
										.sort((a, b) =>
											(b?.ranAt ?? "").localeCompare(a?.ranAt ?? ""),
										)[0];
									return (
										<TableRow key={`${s.type}:${s.id}`}>
											<TableCell className="font-medium">
												{s.name}
												<Badge
													variant="secondary"
													className="ml-2 px-1.5 py-0 text-[10px]"
												>
													{s.type}
												</Badge>
											</TableCell>
											<TableCell className="text-muted-foreground">
												{s.projectName} / {s.environmentName}
											</TableCell>
											<TableCell className="text-sm">
												{svcBackups.length === 0 ? (
													<span className="text-muted-foreground">—</span>
												) : (
													svcBackups.map((b) => (
														<div key={b.backupId} className="text-xs">
															<span className="font-mono">{b.schedule}</span>
															{" → "}
															{b.destinationName ?? "?"}
															{b.enabled === false && (
																<span className="text-amber-600">
																	{" "}
																	(disabled)
																</span>
															)}
														</div>
													))
												)}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{lastRun
													? `${lastRun.status} · ${formatDistanceToNow(new Date(lastRun.ranAt), { addSuffix: true })}`
													: svcBackups.length > 0
														? "not run yet"
														: "—"}
											</TableCell>
											<TableCell className="text-right">
												{svcBackups.length > 0 ? (
													<Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600">
														<ShieldCheck className="size-3" />
														protected
													</Badge>
												) : (
													<div className="flex items-center justify-end gap-2">
														<Badge
															variant="outline"
															className="gap-1 border-amber-500/40 text-amber-600"
														>
															<ShieldAlert className="size-3" />
															no backup
														</Badge>
														<HandleBackup
															id={s.id}
															databaseType={
																s.type as
																	| "postgres"
																	| "mysql"
																	| "mariadb"
																	| "mongo"
																	| "libsql"
															}
															backupType="database"
															refetch={refetch}
														/>
													</div>
												)}
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
		</div>
	);
};
