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
	composeId: string;
}

/**
 * Stack-level CrowdSec opt-out for a compose service. Protected by default; off
 * removes the per-router bouncer from EVERY service in this stack. Only effective
 * when CrowdSec runs in per-service mode (Settings → Web Server → Security); the
 * global/entrypoint mode protects all routes regardless. For finer control, opt a
 * single compose service out with `x-nomad-crowdsec: false` in the compose file.
 * Redeploy to apply.
 */
export const ShowComposeCrowdsec = ({ composeId }: Props) => {
	const { data, refetch } = api.compose.one.useQuery({ composeId });
	const { data: crowdsec } = api.settings.getCrowdsec.useQuery();
	const update = api.compose.update.useMutation();

	const [protectedOn, setProtectedOn] = useState(true);

	useEffect(() => {
		if (!data) return;
		setProtectedOn(data.crowdsecEnabled !== false);
	}, [data]);

	const perServiceActive = !!crowdsec?.enabled && !!crowdsec?.perService;

	const save = async () => {
		try {
			await update.mutateAsync({ composeId, crowdsecEnabled: protectedOn });
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
					Protect this stack's services with the CrowdSec bouncer (blocks banned
					IPs on the load balancer). On by default. Redeploy to apply.
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
							Off = every service in this stack bypasses the bouncer. For a
							single service, use <code>x-nomad-crowdsec: false</code> in the
							compose file instead.
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
