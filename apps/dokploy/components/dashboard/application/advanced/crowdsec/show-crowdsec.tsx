import { Loader2, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
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
 * Per-app CrowdSec opt-out. The bouncer protects every service by default; turning
 * this off tags the app's routers to skip the bouncer. Only has an effect when
 * CrowdSec runs in **per-service mode** (Settings → Web Server → Security); in the
 * global/entrypoint mode the bouncer covers all routes regardless. Redeploy to apply.
 */
export const ShowApplicationCrowdsec = ({ applicationId }: Props) => {
	const { data, refetch } = api.application.one.useQuery({ applicationId });
	const { data: crowdsec } = api.settings.getCrowdsec.useQuery();
	const update = api.application.update.useMutation();

	// Local state mirrors the "protected" switch (crowdsecEnabled; default true).
	const [protectedOn, setProtectedOn] = useState(true);

	useEffect(() => {
		if (!data) return;
		setProtectedOn(data.crowdsecEnabled !== false);
	}, [data]);

	const perServiceActive = !!crowdsec?.enabled && !!crowdsec?.perService;

	const save = async () => {
		try {
			await update.mutateAsync({ applicationId, crowdsecEnabled: protectedOn });
			toast.success("CrowdSec setting saved — redeploy to apply");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<ShieldCheck className="size-5" />
					CrowdSec protection
				</CardTitle>
				<CardDescription>
					Protect this app with the CrowdSec bouncer (blocks banned IPs on the
					load balancer). On by default. Redeploy to apply.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{!perServiceActive && (
					<AlertBlock type="info">
						CrowdSec isn't in <b>per-service mode</b>, so this toggle has no
						effect yet — the bouncer currently applies globally to all routes.
						Enable per-service mode in Settings → Web Server → Security.
					</AlertBlock>
				)}
				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex flex-col gap-1">
						<Label className="text-base">Protected</Label>
						<span className="text-sm text-muted-foreground">
							Off = this app's traffic bypasses the bouncer (e.g. an API the
							crawl scenarios false-positive on).
						</span>
					</div>
					<Switch checked={protectedOn} onCheckedChange={setProtectedOn} />
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
