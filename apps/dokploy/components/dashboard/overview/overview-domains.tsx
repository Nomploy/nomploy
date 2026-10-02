import { ExternalLink, Globe, Loader2, SearchIcon } from "lucide-react";
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

export const OverviewDomains = () => {
	const { data, isLoading } = api.overview.domains.useQuery(undefined, {
		refetchInterval: 20000,
	});
	const [filter, setFilter] = useState("");
	const [project, setProject] = useState(ALL);

	const items = data ?? [];
	const projectNames = useMemo(
		() =>
			Array.from(new Set(items.map((d) => d.projectName))).sort((a, b) =>
				a.localeCompare(b),
			),
		[items],
	);

	const q = filter.toLowerCase();
	const filtered = items.filter((d) => {
		if (project !== ALL && d.projectName !== project) return false;
		return (
			d.host.toLowerCase().includes(q) ||
			d.serviceName.toLowerCase().includes(q)
		);
	});

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<h2 className="font-bold text-xl">
					Domains{" "}
					<span className="text-muted-foreground">({items.length})</span>
				</h2>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<div className="relative">
						<SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
						<Input
							placeholder="Filter domains..."
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
					<span className="text-sm">Loading domains…</span>
				</div>
			) : filtered.length === 0 ? (
				<p className="py-10 text-center text-muted-foreground text-sm">
					{items.length === 0
						? "No domains yet."
						: "No domains match your filter."}
				</p>
			) : (
				<div className="overflow-hidden rounded-lg border">
					<table className="w-full text-sm">
						<thead className="bg-muted/40 text-muted-foreground">
							<tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
								<th>Domain</th>
								<th>Service</th>
								<th>Project</th>
								<th>Cert</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{filtered.map((d) => {
								const url = `${d.https ? "https" : "http"}://${d.host}${
									d.path && d.path !== "/" ? d.path : ""
								}`;
								return (
									<tr
										key={d.domainId}
										className="border-t transition-colors hover:bg-muted/30 [&>td]:px-3 [&>td]:py-2.5"
									>
										<td className="font-medium">
											<span className="inline-flex items-center gap-1.5">
												<Globe className="size-3.5 text-muted-foreground" />
												{d.host}
											</span>
										</td>
										<td className="text-muted-foreground">
											<Link
												href={`/dashboard/project/${d.projectId}/environment/${d.environmentId}/services/${d.serviceType}/${d.serviceId}`}
												className="hover:underline"
											>
												{d.serviceName}
											</Link>{" "}
											<Badge variant="secondary" className="font-normal">
												{d.serviceType}
											</Badge>
										</td>
										<td className="text-muted-foreground">{d.projectName}</td>
										<td>
											<Badge
												variant="outline"
												className="font-normal text-muted-foreground"
											>
												{d.certificateType}
											</Badge>
										</td>
										<td className="text-right">
											<a
												href={url}
												target="_blank"
												rel="noreferrer"
												className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
											>
												Visit <ExternalLink className="size-3" />
											</a>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
};
