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
	composeId: string;
}

/**
 * Per-stack Uptime Kuma opt-out. When an Uptime Kuma connection is enabled for the
 * org, this stack's custom domains are monitored by default; turning this off
 * excludes them from the auto-sync (and removes their monitors on the next sync).
 */
export const ShowComposeUptimeKuma = ({ composeId }: Props) => {
	const { data, refetch } = api.compose.one.useQuery({ composeId });
	const { data: uptimeKuma } = api.uptimeKuma.get.useQuery();
	const update = api.compose.update.useMutation();

	const [monitored, setMonitored] = useState(true);

	useEffect(() => {
		if (!data) return;
		setMonitored(data.uptimeKumaEnabled !== false);
	}, [data]);

	if (!uptimeKuma?.enabled) return null;

	const save = async () => {
		try {
			await update.mutateAsync({ composeId, uptimeKumaEnabled: monitored });
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
					Monitor this stack's domains in Uptime Kuma. On by default.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex flex-col gap-1">
						<Label className="text-base">Monitored</Label>
						<span className="text-sm text-muted-foreground">
							Off = this stack's domains are excluded from Uptime Kuma (its
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
