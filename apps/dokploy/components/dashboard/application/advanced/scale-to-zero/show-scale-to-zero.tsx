import { Loader2, Moon, Save, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
}

/**
 * Scale-to-zero for an application: enable it, then put it to sleep (scale to 0
 * allocations, freeing CPU/RAM) and wake it on demand. A sleeping app stays down
 * across redeploys until woken. Phase 1 is manual (Sleep/Wake); auto-sleep after
 * `idleMinutes` of no traffic + wake-on-request arrive with the activator.
 */
export const ShowApplicationScaleToZero = ({ applicationId }: Props) => {
	const { data, refetch } = api.application.one.useQuery({ applicationId });
	const update = api.application.update.useMutation();
	const sleep = api.application.sleep.useMutation();
	const wake = api.application.wake.useMutation();
	const { data: activity } = api.application.requestActivity.useQuery(
		{ applicationId },
		{ enabled: !!data?.scaleToZeroEnabled, refetchInterval: 60_000 },
	);

	const [enabled, setEnabled] = useState(false);
	const [idleMinutes, setIdleMinutes] = useState("15");

	useEffect(() => {
		if (!data) return;
		setEnabled(data.scaleToZeroEnabled ?? false);
		setIdleMinutes(String(data.idleMinutes ?? 15));
	}, [data]);

	const isSleeping = data?.isSleeping ?? false;
	const busy = update.isPending || sleep.isPending || wake.isPending;

	const save = async () => {
		const n = Number(idleMinutes);
		if (!Number.isInteger(n) || n <= 0) {
			toast.error("Idle minutes must be a positive whole number");
			return;
		}
		try {
			await update.mutateAsync({
				applicationId,
				scaleToZeroEnabled: enabled,
				idleMinutes: n,
			});
			toast.success("Scale-to-zero settings saved");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	const doSleep = async () => {
		try {
			await sleep.mutateAsync({ applicationId });
			toast.success("Sleeping — scaled to 0");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to sleep");
		}
	};

	const doWake = async () => {
		try {
			await wake.mutateAsync({ applicationId });
			toast.success("Waking — scaling back up");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to wake");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Moon className="size-5" />
					Scale to zero
					{isSleeping && (
						<Badge variant="secondary" className="ml-1">
							Sleeping
						</Badge>
					)}
				</CardTitle>
				<CardDescription>
					Scale this app to 0 allocations when idle to free CPU/RAM, and wake it
					on demand. A sleeping app stays down across redeploys until woken.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex flex-col gap-1">
						<Label className="text-base">Enabled</Label>
						<span className="text-sm text-muted-foreground">
							Allow this app to be scaled to zero: auto-sleep after the idle
							window and wake on the next request. Needs the activator
							(Settings → Web Server) for both; Sleep / Wake buttons work
							without it.
						</span>
					</div>
					<Switch checked={enabled} onCheckedChange={setEnabled} />
				</div>
				{enabled && activity && (
					<p className="text-muted-foreground text-sm">
						{activity.collecting
							? "Collecting traffic samples…"
							: `${activity.requestsLastHour} requests in the last hour · idle ${activity.idleMinutes} min`}
					</p>
				)}
				<div className="space-y-1.5 sm:max-w-xs">
					<Label>Auto-sleep after (minutes idle)</Label>
					<Input
						type="number"
						min={1}
						value={idleMinutes}
						onChange={(e) => setIdleMinutes(e.target.value)}
						disabled={!enabled}
					/>
					<p className="text-muted-foreground text-xs">
						Auto-sleep triggers after this many minutes without a request
						(activator must be on); manual Sleep/Wake always works.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button type="button" onClick={save} disabled={busy}>
						{update.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Save className="mr-2 h-4 w-4" />
						)}
						Save
					</Button>
					{isSleeping ? (
						<Button
							type="button"
							variant="secondary"
							onClick={doWake}
							disabled={busy}
						>
							{wake.isPending ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<Sun className="mr-2 h-4 w-4" />
							)}
							Wake
						</Button>
					) : (
						<Button
							type="button"
							variant="secondary"
							onClick={doSleep}
							disabled={busy || !enabled}
						>
							{sleep.isPending ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<Moon className="mr-2 h-4 w-4" />
							)}
							Sleep now
						</Button>
					)}
				</div>
			</CardContent>
		</Card>
	);
};
