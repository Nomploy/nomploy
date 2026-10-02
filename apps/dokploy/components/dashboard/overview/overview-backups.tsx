import { DatabaseBackup, Loader2, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

const ALL = "__all__";

export const OverviewBackups = () => {
	const { data, isLoading } = api.overview.backups.useQuery(undefined, {
		refetchInterval: 20000,
	});
	const [filter, setFilter] = useState("");
	const [project, setProject] = useState(ALL);

	const items = data ?? [];
	const projectNames = useMemo(
		() =>
			Array.from(new Set(items.map((b) => b.projectName))).sort((a, b) =>
				a.localeCompare(b),
			),
		[items],
	);

	const q = filter.toLowerCase();
	const filtered = items.filter((b) => {
		if (project !== ALL && b.projectName !== project) return false;
		return (
			b.serviceName.toLowerCase().includes(q) ||
			b.database.toLowerCase().includes(q) ||
			(b.destinationName ?? "").toLowerCase().includes(q)
		);
	});

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<h2 className="font-bold text-xl">
					Backups{" "}
					<span className="text-muted-foreground">({items.length})</span>
				</h2>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<div className="relative">
						<SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
						<Input
							placeholder="Filter backups..."
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							className="w-full pl-8 sm:w-[260px]"
						/>
					</div>
					<Select value={project} onValueChange={setProject}>
						<SelectTrigger className="w-full sm:w-[200px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All projects</SelectItem>
							{projectNames.map((p) => (
								<SelectItem key={p} value={p}>
									{p}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{isLoading ? (
				<div className="flex min-h-[30vh] items-center justify-center gap-2 text-muted-foreground">
					<Loader2 className="size-5 animate-spin" />
					<span className="text-sm">Loading backups…</span>
				</div>
			) : filtered.length === 0 ? (
				<p className="py-10 text-center text-muted-foreground text-sm">
					{items.length === 0
						? "No scheduled backups yet."
						: "No backups match your filter."}
				</p>
			) : (
				<div className="overflow-hidden rounded-lg border">
					<table className="w-full text-sm">
						<thead className="bg-muted/40 text-muted-foreground">
							<tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
								<th>Service</th>
								<th>Database</th>
								<th>Schedule</th>
								<th>Destination</th>
								<th>Project</th>
								<th className="text-center">Enabled</th>
							</tr>
						</thead>
						<tbody>
							{filtered.map((b) => (
								<tr
									key={b.backupId}
									className="border-t transition-colors hover:bg-muted/30 [&>td]:px-3 [&>td]:py-2.5"
								>
									<td className="font-medium">
										<Link
											href={`/dashboard/project/${b.projectId}/environment/${b.environmentId}/services/${b.serviceType}/${b.serviceId}`}
											className="inline-flex items-center gap-1.5 hover:underline"
										>
											<DatabaseBackup className="size-3.5 text-muted-foreground" />
											{b.serviceName}
										</Link>
									</td>
									<td className="text-muted-foreground">
										{b.database || "—"}{" "}
										<Badge variant="secondary" className="font-normal">
											{b.databaseType}
										</Badge>
									</td>
									<td>
										<code className="text-muted-foreground text-xs">
											{b.schedule}
										</code>
									</td>
									<td className="text-muted-foreground">
										{b.destinationName ?? "—"}
									</td>
									<td className="text-muted-foreground">{b.projectName}</td>
									<td className="text-center">
										{b.enabled ? (
											<Badge
												variant="outline"
												className="border-emerald-500/40 text-emerald-500"
											>
												on
											</Badge>
										) : (
											<Badge
												variant="outline"
												className="text-muted-foreground"
											>
												off
											</Badge>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
};
