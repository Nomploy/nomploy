import { AlertTriangle, Lightbulb, Moon, TrendingDown } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
 * In-panel utilization/scaling suggestions from the sampled metric history
 * (running hot / over-provisioned / idle). Renders nothing until there are
 * suggestions, so it stays invisible on fresh installs. A daily digest of the
 * same analysis goes to the org's notification channels.
 */
export const ScalingSuggestions = () => {
	const { data } = api.nomad.getScalingSuggestions.useQuery(undefined, {
		refetchInterval: 60000,
	});
	if (!data || data.length === 0) return null;

	return (
		<Card className="bg-sidebar">
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-base">
					<Lightbulb className="size-4 text-yellow-500" />
					Utilization suggestions
					<span className="text-xs font-normal text-muted-foreground">
						({data.length}) — from the last 24h of metrics
					</span>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-2">
				{data.map((s) => {
					const { Icon, className } = KIND[s.kind];
					return (
						<Link
							key={`${s.serviceType}:${s.serviceId}`}
							href={`/dashboard/project/${s.projectId}/environment/${s.environmentId}/services/${s.serviceType}/${s.serviceId}`}
							className="flex items-start gap-2 rounded-lg border p-2.5 text-sm transition-colors hover:bg-border"
						>
							<Icon className={`mt-0.5 size-4 shrink-0 ${className}`} />
							<span className="flex flex-col">
								<span>{s.message}</span>
								<span className="text-xs text-muted-foreground">
									{s.projectName} · CPU {s.cpuPct}% · mem {s.memPct}% of
									reserved
								</span>
							</span>
						</Link>
					);
				})}
			</CardContent>
		</Card>
	);
};
