import { Gauge, Loader2, Save } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
}

/**
 * Metrics scraping for an application's Nomad job. When a port is set, the app's
 * primary Consul service is tagged `nomploy.metrics.port=<port>`, so the
 * built-in OpenTelemetry Collector (Settings → Web Server → Observability)
 * discovers and scrapes its `/metrics`. Empty = not scraped. Redeploy to apply.
 */
export const ShowApplicationMetrics = ({ applicationId }: Props) => {
	const { data, refetch } = api.application.one.useQuery({ applicationId });
	const update = api.application.update.useMutation();

	const [port, setPort] = useState<string>("");

	useEffect(() => {
		if (!data) return;
		setPort(data.metricsPort != null ? String(data.metricsPort) : "");
	}, [data]);

	const save = async () => {
		const trimmed = port.trim();
		const n = Number(trimmed);
		if (trimmed !== "" && (!Number.isInteger(n) || n <= 0 || n > 65535)) {
			toast.error("Metrics port must be between 1 and 65535");
			return;
		}
		try {
			await update.mutateAsync({
				applicationId,
				metricsPort: trimmed === "" ? null : n,
			});
			toast.success("Metrics settings saved — redeploy to apply");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Gauge className="size-5" />
					Metrics
				</CardTitle>
				<CardDescription>
					Expose this app's Prometheus <code>/metrics</code> to the built-in
					OpenTelemetry Collector. Set the container port it serves metrics on;
					the service gets tagged <code>nomploy.metrics.port=&lt;port&gt;</code>{" "}
					so the collector scrapes it. Empty = not scraped. Redeploy to apply.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="space-y-1.5 sm:max-w-xs">
					<Label>Metrics port</Label>
					<Input
						type="number"
						min={1}
						max={65535}
						placeholder="e.g. 9090"
						value={port}
						onChange={(e) => setPort(e.target.value)}
					/>
					<p className="text-muted-foreground text-xs">
						If the endpoint needs auth, set the scrape credential in Settings →
						Web Server → Observability.
					</p>
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
