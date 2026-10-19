import {
	AlertTriangle,
	ChevronRight,
	Lightbulb,
	Loader2,
	Moon,
	Power,
	TrendingDown,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

const ApplyRightsizeButton = ({
	serviceType,
	serviceId,
	serviceName,
	cpuMhz,
	memMb,
	onDone,
}: {
	serviceType: string;
	serviceId: string;
	serviceName: string;
	cpuMhz: number;
	memMb: number;
	onDone: () => void;
}) => {
	const { mutateAsync, isPending } = api.nomad.applyRightsize.useMutation();
	const isApp = serviceType === "application";
	const apply = async () => {
		try {
			await mutateAsync({ serviceType, serviceId, cpuMhz, memMb });
			toast.success("Right-size applied — redeploying");
			onDone();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to apply");
		}
	};
	return (
		<DialogAction
			title="Apply right-size?"
			description={`Set ${serviceName}'s reserved resources to ${cpuMhz} MHz CPU / ${memMb} MB and redeploy it. ${
				isApp
					? "A volumeless app rolls with a zero-downtime canary; a single-replica app with a writable volume restarts briefly."
					: "The database reschedules its allocation and restarts briefly (a few seconds of downtime) — it holds a writable volume so there's no canary."
			}`}
			onClick={apply}
		>
			<Button type="button" size="sm" variant="outline" disabled={isPending}>
				{isPending ? (
					<Loader2 className="mr-1 size-3.5 animate-spin" />
				) : (
					<TrendingDown className="mr-1 size-3.5" />
				)}
				Apply
			</Button>
		</DialogAction>
	);
};

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

const AutoStopButton = ({
	serviceType,
	serviceId,
	onDone,
}: {
	serviceType: string;
	serviceId: string;
	onDone: () => void;
}) => {
	const appUpdate = api.application.update.useMutation();
	const composeUpdate = api.compose.update.useMutation();
	const pending = appUpdate.isPending || composeUpdate.isPending;
	const enable = async () => {
		try {
			if (serviceType === "application") {
				await appUpdate.mutateAsync({
					applicationId: serviceId,
					scaleToZeroEnabled: true,
				});
			} else {
				await composeUpdate.mutateAsync({
					composeId: serviceId,
					scaleToZeroEnabled: true,
				});
			}
			toast.success(
				"Scale-to-zero enabled — it auto-stops when idle and wakes on request (needs the activator, in Settings → Web Server)",
			);
			onDone();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to enable");
		}
	};
	return (
		<DialogAction
			title="Enable scale-to-zero (auto-stop)?"
			description="The service will scale to 0 after its idle window and wake automatically on the next request. Needs the activator enabled (Settings → Web Server) so a request can wake it; otherwise it only sleeps/wakes from the buttons in its Advanced tab."
			onClick={enable}
		>
			<Button type="button" size="sm" variant="ghost" disabled={pending}>
				{pending ? (
					<Loader2 className="mr-1 size-3.5 animate-spin" />
				) : (
					<Power className="mr-1 size-3.5" />
				)}
				Auto-stop
			</Button>
		</DialogAction>
	);
};

/**
 * The full utilization/scaling suggestions list — rendered on the dedicated
 * /dashboard/suggestions page. Kept off the Projects page (which only shows a
 * compact banner) so a long list never pushes the project grid down.
 */
export const SuggestionsList = () => {
	const { data, refetch } = api.nomad.getScalingSuggestions.useQuery(
		undefined,
		{ refetchInterval: 60000 },
	);
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
				const resized =
					s.current.cpuMhz !== s.recommended.cpuMhz ||
					s.current.memMb !== s.recommended.memMb;
				return (
					<div
						key={`${s.serviceType}:${s.serviceId}`}
						className="flex items-start gap-2.5 rounded-lg border p-3 text-sm"
					>
						<Icon className={`mt-0.5 size-4 shrink-0 ${className}`} />
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="font-medium">{s.serviceName}</span>
								<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
									{s.serviceType}
								</Badge>
								<span className="text-xs text-muted-foreground">
									in {s.projectName}
								</span>
								{s.estMonthlySaving > 0 && (
									<Badge className="bg-emerald-600 px-1.5 py-0 text-[10px] hover:bg-emerald-600">
										saves ~{s.estMonthlySaving} €/mo
									</Badge>
								)}
							</div>
							<span>{s.message}</span>
							{resized && (
								<span className="text-xs text-muted-foreground">
									Reserve{" "}
									<span className="font-medium text-foreground">
										{s.current.cpuMhz}→{s.recommended.cpuMhz} MHz CPU
									</span>
									{" · "}
									<span className="font-medium text-foreground">
										{s.current.memMb}→{s.recommended.memMb} MB mem
									</span>
								</span>
							)}
							<Link
								href={`/dashboard/project/${s.projectId}/environment/${s.environmentId}/services/${s.serviceType}/${s.serviceId}`}
								className="truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
							>
								{s.appName} · {s.samples} samples — open
							</Link>
						</div>
						<div className="flex shrink-0 flex-col items-end gap-1">
							{s.canApply ? (
								<ApplyRightsizeButton
									serviceType={s.serviceType}
									serviceId={s.serviceId}
									serviceName={s.serviceName}
									cpuMhz={s.recommended.cpuMhz}
									memMb={s.recommended.memMb}
									onDone={() => refetch()}
								/>
							) : (
								resized && (
									<span className="self-center text-right text-xs text-muted-foreground">
										edit in its file
									</span>
								)
							)}
							{s.kind === "idle" && s.canAutoStop && (
								<AutoStopButton
									serviceType={s.serviceType}
									serviceId={s.serviceId}
									onDone={() => refetch()}
								/>
							)}
						</div>
					</div>
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
