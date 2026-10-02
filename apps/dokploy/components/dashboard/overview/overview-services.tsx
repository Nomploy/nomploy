import { ExternalLink, Loader2, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { StatusTooltip } from "@/components/shared/status-tooltip";
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

type Status = "idle" | "running" | "done" | "error" | "cancelled" | null;

const TYPE_LABEL: Record<string, string> = {
	application: "App",
	compose: "Compose",
	postgres: "Postgres",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "Mongo",
	redis: "Redis",
	libsql: "LibSQL",
};

const ALL = "__all__";

export const OverviewServices = () => {
	const { data, isLoading } = api.overview.services.useQuery(undefined, {
		refetchInterval: 15000,
	});
	const [filter, setFilter] = useState("");
	const [project, setProject] = useState(ALL);

	const services = data ?? [];
	const projectNames = useMemo(
		() =>
			Array.from(new Set(services.map((s) => s.projectName))).sort((a, b) =>
				a.localeCompare(b),
			),
		[services],
	);

	const q = filter.toLowerCase();
	const filtered = services.filter((s) => {
		if (project !== ALL && s.projectName !== project) return false;
		return (
			s.name.toLowerCase().includes(q) ||
			(s.appName ?? "").toLowerCase().includes(q) ||
			s.type.toLowerCase().includes(q)
		);
	});

	// At-a-glance health across the (filtered) services. Status enum (matches the
	// StatusTooltip dot): done = deployed/healthy (green), running = deploying
	// (amber), error = failed (red), idle = never deployed (muted).
	const counts = filtered.reduce(
		(acc, s) => {
			if (s.status === "done") acc.done++;
			else if (s.status === "running") acc.running++;
			else if (s.status === "error") acc.error++;
			else acc.idle++;
			return acc;
		},
		{ done: 0, running: 0, error: 0, idle: 0 },
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex flex-col gap-1">
					<h2 className="font-bold text-xl">
						Services{" "}
						<span className="text-muted-foreground">({services.length})</span>
					</h2>
					{filtered.length > 0 && (
						<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
							<span className="inline-flex items-center gap-1">
								<span className="size-2 rounded-full bg-emerald-500" />
								{counts.done} healthy
							</span>
							{counts.error > 0 && (
								<span className="inline-flex items-center gap-1">
									<span className="size-2 rounded-full bg-destructive" />
									{counts.error} error
								</span>
							)}
							{counts.idle > 0 && (
								<span className="inline-flex items-center gap-1">
									<span className="size-2 rounded-full bg-muted-foreground" />
									{counts.idle} idle
								</span>
							)}
						</div>
					)}
				</div>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<div className="relative">
						<SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
						<Input
							placeholder="Filter services..."
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
					<span className="text-sm">Loading services…</span>
				</div>
			) : filtered.length === 0 ? (
				<p className="py-10 text-center text-muted-foreground text-sm">
					{services.length === 0
						? "No services yet."
						: "No services match your filter."}
				</p>
			) : (
				<div className="overflow-hidden rounded-lg border">
					<table className="w-full text-sm">
						<thead className="bg-muted/40 text-muted-foreground">
							<tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
								<th>Name</th>
								<th>Type</th>
								<th>Project</th>
								<th>Environment</th>
								<th className="text-center">Status</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{filtered.map((s) => (
								<tr
									key={`${s.type}-${s.id}`}
									className="border-t transition-colors hover:bg-muted/30 [&>td]:px-3 [&>td]:py-2.5"
								>
									<td className="font-medium">
										<Link
											href={`/dashboard/project/${s.projectId}/environment/${s.environmentId}/services/${s.type}/${s.id}`}
											className="hover:underline"
										>
											{s.name}
										</Link>
									</td>
									<td>
										<Badge variant="secondary" className="font-normal">
											{TYPE_LABEL[s.type] ?? s.type}
										</Badge>
									</td>
									<td className="text-muted-foreground">{s.projectName}</td>
									<td className="text-muted-foreground">{s.environmentName}</td>
									<td className="text-center">
										<div className="flex justify-center">
											<StatusTooltip status={s.status as Status} />
										</div>
									</td>
									<td className="text-right">
										<Link
											href={`/dashboard/project/${s.projectId}/environment/${s.environmentId}/services/${s.type}/${s.id}`}
											className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
										>
											Open <ExternalLink className="size-3" />
										</Link>
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
