import { Moon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
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

/**
 * Global toggle for the scale-to-zero **activator** (wake-on-request). When on, a
 * small proxy runs on every LB node with a lowest-priority catch-all route; a
 * request to a sleeping service falls through to it, it wakes the owning service
 * and returns a "waking up, retry" page. Off → sleeping services only wake via the
 * per-service Wake button.
 */
export const ShowActivator = () => {
	const { data, refetch } = api.settings.getActivator.useQuery();
	const { mutateAsync, isPending } = api.settings.saveActivator.useMutation();

	const [enabled, setEnabled] = useState(false);
	const prefilled = useRef(false);
	useEffect(() => {
		if (!data || prefilled.current) return;
		setEnabled(data.enabled);
		prefilled.current = true;
	}, [data]);

	const save = async (next: boolean) => {
		setEnabled(next);
		try {
			await mutateAsync({ enabled: next });
			toast.success(
				next ? "Activator enabled — deploying" : "Activator disabled",
			);
			await refetch();
		} catch (err) {
			setEnabled(!next);
			toast.error(err instanceof Error ? err.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Moon className="size-5" />
					Scale-to-zero activator (wake-on-request)
				</CardTitle>
				<CardDescription>
					Run a tiny proxy on the LB nodes so a request to a sleeping service
					wakes it automatically (otherwise sleeping services wake only via
					their Wake button). Enable scale-to-zero per service in its Advanced
					tab.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<AlertBlock type="info">
					The activator adds a <b>lowest-priority catch-all route</b> on the
					load balancer — a running service's own route always wins; only a
					sleeping service (its route gone) falls through to the activator.
				</AlertBlock>
				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex flex-col gap-1">
						<Label className="text-base">Wake-on-request</Label>
						<span className="text-sm text-muted-foreground">
							Deploy the activator + its catch-all route on every LB node.
						</span>
					</div>
					<Switch
						checked={enabled}
						onCheckedChange={save}
						disabled={isPending}
					/>
				</div>
			</CardContent>
		</Card>
	);
};
