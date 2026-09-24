import {
	AlertTriangle,
	ChevronRight,
	Lightbulb,
	Moon,
	TrendingDown,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { api } from "@/utils/api";

const KIND = {
	under_provisioned: {
		Icon: AlertTriangle,
		className: "text-destructive",
	},
	over_provisioned: {
		Icon: TrendingDown,
		className: "text-blue-500",
	},
	idle: {
		Icon: Moon,
		className: "text-muted-foreground",
	},
} as const;

/**
 * The full utilization/scaling suggestions list — rendered on the dedicated
 * /dashboard/suggestions page. Kept off the Projects page (which only shows a
 * compact banner) so a long list never pushes the project grid down.
 */
export const SuggestionsList = () => {
	const { data } = api.nomad.getScalingSuggestions.useQuery(undefined, {
		refetchInterval: 60000,
	});
	if (!data) return null;
	if (data.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				No utilization suggestions right now — your services are sized about
				right. Suggestions appear after a few hours of metrics.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			{data.map((s) => {
				const { Icon, className } = KIND[s.kind];
				return (
					<Link
						key={`${s.serviceType}:${s.serviceId}`}
						href={`/dashboard/project/${s.projectId}/environment/${s.environmentId}/services/${s.serviceType}/${s.serviceId}`}
						className="flex items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors hover:bg-border"
					>
						<Icon className={`mt-0.5 size-4 shrink-0 ${className}`} />
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="flex flex-wrap items-center gap-1.5">
								<span className="font-medium">{s.serviceName}</span>
								<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
									{s.serviceType}
								</Badge>
								<span className="text-xs text-muted-foreground">
									in {s.projectName}
								</span>
							</span>
							<span>{s.message}</span>
							<span className="truncate text-xs text-muted-foreground">
								{s.appName} · {s.samples} samples
							</span>
						</span>
					</Link>
				);
			})}
		</div>
	);
};

/**
 * Compact one-line banner for the Projects page: shows the suggestion count and
 * links to the full /dashboard/suggestions page. Renders nothing when there are
 * no suggestions, so it stays invisible on fresh installs and never drifts the
 * project grid.
 */
export const ScalingSuggestions = () => {
	const { data } = api.nomad.getScalingSuggestions.useQuery(undefined, {
		refetchInterval: 60000,
	});
	if (!data || data.length === 0) return null;
	return (
		<Link
			href="/dashboard/suggestions"
			className="flex items-center justify-between gap-2 rounded-lg border bg-sidebar px-4 py-2.5 text-sm transition-colors hover:bg-border"
		>
			<span className="flex items-center gap-2">
				<Lightbulb className="size-4 text-yellow-500" />
				<span className="font-medium">Utilization suggestions</span>
				<Badge variant="secondary">{data.length}</Badge>
				<span className="text-muted-foreground max-sm:hidden">
					— from the last 24h of metrics
				</span>
			</span>
			<ChevronRight className="size-4 text-muted-foreground" />
		</Link>
	);
};
