/**
 * nomploy — original (Apache/AGPL) Audit Logs view. Lists who did what to which
 * resource, newest first, with search + pagination. Reads api.auditLog.all.
 */
import { Loader2, RefreshCw, ScrollText } from "lucide-react";
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

const PAGE = 25;

export function ShowAuditLogs() {
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(0);

	const { data, isLoading, refetch, isRefetching } = api.auditLog.all.useQuery({
		resourceName: search || undefined,
		limit: PAGE,
		offset: page * PAGE,
	});

	const logs = data?.logs ?? [];
	const total = data?.total ?? 0;
	const lastPage = Math.max(0, Math.ceil(total / PAGE) - 1);

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1.5">
					<CardTitle className="flex items-center gap-2 text-xl">
						<ScrollText className="size-5" />
						Audit Logs
					</CardTitle>
					<CardDescription>
						Who did what, when — actions across your organization, newest first.
					</CardDescription>
				</div>
				<Button
					variant="ghost"
					size="icon"
					onClick={() => refetch()}
					disabled={isRefetching}
				>
					<RefreshCw
						className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`}
					/>
				</Button>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<Input
					placeholder="Filter by resource name…"
					value={search}
					onChange={(e) => {
						setPage(0);
						setSearch(e.target.value);
					}}
					className="max-w-sm"
				/>

				<div className="rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>When</TableHead>
								<TableHead>User</TableHead>
								<TableHead>Action</TableHead>
								<TableHead>Resource</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{isLoading ? (
								<TableRow>
									<TableCell colSpan={4} className="py-8 text-center">
										<Loader2 className="mx-auto h-5 w-5 animate-spin" />
									</TableCell>
								</TableRow>
							) : logs.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={4}
										className="py-8 text-center text-muted-foreground text-sm"
									>
										No audit entries yet.
									</TableCell>
								</TableRow>
							) : (
								logs.map((log) => (
									<TableRow key={log.id}>
										<TableCell className="whitespace-nowrap text-muted-foreground text-xs">
											{new Date(log.createdAt).toLocaleString()}
										</TableCell>
										<TableCell>
											<div className="flex flex-col">
												<span className="text-sm">{log.userEmail}</span>
												<span className="text-muted-foreground text-xs">
													{log.userRole}
												</span>
											</div>
										</TableCell>
										<TableCell>
											<Badge variant="outline">{log.action}</Badge>
										</TableCell>
										<TableCell>
											<div className="flex flex-col">
												<span className="text-sm">
													{log.resourceName || "—"}
												</span>
												<span className="text-muted-foreground text-xs">
													{log.resourceType}
												</span>
											</div>
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</div>

				<div className="flex items-center justify-between text-muted-foreground text-xs">
					<span>
						{total === 0
							? "0 entries"
							: `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, total)} of ${total}`}
					</span>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={page === 0}
							onClick={() => setPage((p) => Math.max(0, p - 1))}
						>
							Previous
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={page >= lastPage}
							onClick={() => setPage((p) => p + 1)}
						>
							Next
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
