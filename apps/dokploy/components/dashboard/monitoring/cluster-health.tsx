import {
	AlertTriangle,
	Ban,
	DatabaseBackup,
	HeartPulse,
	PiggyBank,
	Server,
} from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/utils/api";

type Tone = "ok" | "warn" | "bad" | "muted";
const toneClass: Record<Tone, string> = {
	ok: "text-emerald-600",
	warn: "text-amber-600 dark:text-amber-500",
	bad: "text-destructive",
	muted: "text-muted-foreground",
};

const Stat = ({
	icon: Icon,
	label,
	value,
	sub,
	tone,
	href,
}: {
	icon: typeof Server;
	label: string;
	value: string;
	sub?: string;
	tone: Tone;
	href: string;
}) => (
	<Link href={href}>
		<Card className="flex h-full flex-col gap-1 bg-background p-3 transition-colors hover:bg-border">
			<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Icon className={`size-3.5 ${toneClass[tone]}`} />
				{label}
			</span>
			<span className={`text-lg font-semibold ${toneClass[tone]}`}>{value}</span>
			{sub && <span className="text-xs text-muted-foreground">{sub}</span>}
		</Card>
	</Link>
);

/**
 * A compact, actionable cluster-health strip for the top of the Monitoring
 * overview: nodes, blocked placements, firing alerts, cost projection vs budget,
 * available savings and backup gaps — each a link to where you'd act on it.
 */
export const ShowClusterHealth = () => {
	const { data: h, isLoading } = api.nomad.getClusterHealth.useQuery(undefined, {
		refetchInterval: 30000,
	});
	if (isLoading) return <Skeleton className="h-24 w-full" />;
	if (!h) return null;

	const cur = h.currency;
	const fmt = (n: number) => `${Math.round(n)} ${cur}`;

	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
			<Stat
				icon={Server}
				label="Nodes"
				value={`${h.nodes.ready}/${h.nodes.total}`}
				sub={
					h.nodes.down > 0
						? `${h.nodes.down} down`
						: h.nodes.draining > 0
							? `${h.nodes.draining} draining`
							: "all ready"
				}
				tone={h.nodes.down > 0 ? "bad" : h.nodes.draining > 0 ? "warn" : "ok"}
				href="/dashboard/nomad"
			/>
			<Stat
				icon={AlertTriangle}
				label="Alerts"
				value={`${h.alertsFiring}`}
				sub={h.alertsFiring > 0 ? "firing" : "all clear"}
				tone={h.alertsFiring > 0 ? "bad" : "ok"}
				href="/dashboard/monitoring?tab=alerts"
			/>
			<Stat
				icon={Ban}
				label="Blocked"
				value={`${h.blockedEvals}`}
				sub={h.blockedEvals > 0 ? "placements" : "none"}
				tone={h.blockedEvals > 0 ? "warn" : "ok"}
				href="/dashboard/nomad"
			/>
			<Stat
				icon={HeartPulse}
				label="Cost (proj.)"
				value={fmt(h.cost.projectedMonthEnd)}
				sub={
					h.cost.budget > 0
						? h.cost.overBudget
							? `over ${fmt(h.cost.budget)}`
							: `of ${fmt(h.cost.budget)}`
						: `${fmt(h.cost.runRate)}/mo rate`
				}
				tone={h.cost.overBudget ? "bad" : "muted"}
				href="/dashboard/cost"
			/>
			<Stat
				icon={PiggyBank}
				label="Savings"
				value={h.savings.potential > 0 ? `~${fmt(h.savings.potential)}` : "—"}
				sub={
					h.savings.suggestions > 0
						? `${h.savings.suggestions} suggestion(s)`
						: "right-sized"
				}
				tone={h.savings.potential > 0 ? "warn" : "ok"}
				href="/dashboard/suggestions"
			/>
			<Stat
				icon={DatabaseBackup}
				label="Backups"
				value={`${h.backups.withoutBackup}`}
				sub={
					h.backups.withoutBackup > 0
						? `DB(s) unprotected`
						: `${h.backups.databases} DB(s) covered`
				}
				tone={h.backups.withoutBackup > 0 ? "warn" : "ok"}
				href="/dashboard/overview"
			/>
		</div>
	);
};
