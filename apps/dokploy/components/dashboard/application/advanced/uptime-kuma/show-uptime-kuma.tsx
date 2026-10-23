import { Activity, Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
}

/**
 * Per-app Uptime Kuma opt-out. When an Uptime Kuma connection is enabled for the
 * org, this app's custom domains are monitored by default; turning this off
 * excludes them from the auto-sync (and removes their monitors on the next sync).
 * Only shown when the org has Uptime Kuma connected + enabled.
 */
export const ShowApplicationUptimeKuma = ({ applicationId }: Props) => {
	const { data, refetch } = api.application.one.useQuery({ applicationId });
	const { data: uptimeKuma } = api.uptimeKuma.get.useQuery();
	const update = api.application.update.useMutation();

	const [monitored, setMonitored] = useState(true);

	useEffect(() => {
		if (!data) return;
		setMonitored(data.uptimeKumaEnabled !== false);
	}, [data]);

	// Only relevant when the org actually has Uptime Kuma syncing.
	if (!uptimeKuma?.enabled) return null;

	const save = async () => {
		try {
			await update.mutateAsync({ applicationId, uptimeKumaEnabled: monitored });
			toast.success("Uptime Kuma setting saved");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Activity className="size-5" />
					Uptime Kuma
				</CardTitle>
				<CardDescription>
					Monitor this app's domains in Uptime Kuma. On by default.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex flex-col gap-1">
						<Label className="text-base">Monitored</Label>
						<span className="text-sm text-muted-foreground">
							Off = this app's domains are excluded from Uptime Kuma (its
							monitors are removed on the next sync).
						</span>
					</div>
					<Switch checked={monitored} onCheckedChange={setMonitored} />
				</div>
				<div>
					<Button type="button" onClick={save} disabled={update.isPending}>
						{update.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Save className="mr-2 h-4 w-4" />
						)}
						{update.isPending ? "Saving…" : "Save"}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
