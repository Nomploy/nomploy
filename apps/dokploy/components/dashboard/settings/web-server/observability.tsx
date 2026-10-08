import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
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

export const Observability = () => {
	const { data, refetch } = api.settings.getObservability.useQuery();
	const { mutateAsync: saveObservability, isPending } =
		api.settings.saveObservability.useMutation();

	const [enabled, setEnabled] = useState(false);
	const [otlpEndpoint, setOtlpEndpoint] = useState("");
	const [headerKey, setHeaderKey] = useState("");
	const [headerValue, setHeaderValue] = useState("");
	const [scrapeInterval, setScrapeInterval] = useState("30");
	const [scrapeBearerToken, setScrapeBearerToken] = useState("");

	// Prefill once the stored config loads.
	useEffect(() => {
		if (!data) return;
		setEnabled(data.enabled);
		setOtlpEndpoint(data.otlpEndpoint);
		setScrapeInterval(String(data.scrapeIntervalSeconds));
		setScrapeBearerToken(data.scrapeBearerToken ?? "");
		const entries = Object.entries(data.otlpHeaders ?? {});
		if (entries[0]) {
			setHeaderKey(entries[0][0]);
			setHeaderValue(entries[0][1]);
		}
	}, [data]);

	const scrapeNum = Number(scrapeInterval);
	const scrapeValid =
		Number.isInteger(scrapeNum) && scrapeNum >= 5 && scrapeNum <= 3600;
	const endpointValid = !enabled || otlpEndpoint.trim().length > 0;
	const canSave = scrapeValid && endpointValid && !isPending;

	const buildHeaders = (): Record<string, string> => {
		const headers: Record<string, string> = {};
		const k = headerKey.trim();
		if (k.length > 0) {
			headers[k] = headerValue;
		}
		return headers;
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-lg">Observability (OpenTelemetry)</CardTitle>
				<CardDescription>
					Run a managed OpenTelemetry Collector that discovers services via
					Consul and ships their Prometheus metrics to an OTLP backend (e.g.
					SigNoz). It scrapes services tagged{" "}
					<code>nomploy.metrics.port=&lt;port&gt;</code> plus the Traefik load
					balancer, and forwards everything to the OTLP endpoint below.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex items-center justify-between gap-4">
					<div className="flex flex-col gap-1">
						<Label htmlFor="otel-enabled">Enable collector</Label>
						<span className="text-sm text-muted-foreground">
							Deploys a cluster-wide collector job when enabled.
						</span>
					</div>
					<Switch
						id="otel-enabled"
						checked={enabled}
						onCheckedChange={setEnabled}
					/>
				</div>

				<div className="flex w-full flex-col gap-2">
					<Label htmlFor="otel-endpoint">OTLP endpoint</Label>
					<Input
						id="otel-endpoint"
						placeholder="https://ingest.<region>.signoz.cloud:443"
						value={otlpEndpoint}
						onChange={(e) => setOtlpEndpoint(e.target.value)}
					/>
				</div>

				<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
					<div className="flex w-full flex-col gap-2">
						<Label htmlFor="otel-header-key">Header name</Label>
						<Input
							id="otel-header-key"
							placeholder="signoz-ingestion-key"
							value={headerKey}
							onChange={(e) => setHeaderKey(e.target.value)}
						/>
					</div>
					<div className="flex w-full flex-col gap-2">
						<Label htmlFor="otel-header-value">Header value</Label>
						<Input
							id="otel-header-value"
							placeholder="<your-ingestion-key>"
							value={headerValue}
							onChange={(e) => setHeaderValue(e.target.value)}
						/>
					</div>
				</div>

				<div className="flex w-full flex-col gap-2">
					<Label htmlFor="otel-scrape-token">
						Scrape bearer token (optional)
					</Label>
					<Input
						id="otel-scrape-token"
						type="password"
						placeholder="Sent as Authorization: Bearer <token> to service /metrics"
						value={scrapeBearerToken}
						onChange={(e) => setScrapeBearerToken(e.target.value)}
					/>
					<span className="text-sm text-muted-foreground">
						Used when a service's <code>/metrics</code> endpoint requires auth.
						Not sent to the Traefik load balancer.
					</span>
				</div>

				<div className="flex w-full flex-col gap-2 sm:max-w-xs">
					<Label htmlFor="otel-interval">Scrape interval (s)</Label>
					<Input
						id="otel-interval"
						type="number"
						min={5}
						max={3600}
						placeholder="30"
						value={scrapeInterval}
						onChange={(e) => setScrapeInterval(e.target.value)}
					/>
				</div>

				<div className="flex justify-end">
					<DialogAction
						title="Save observability settings"
						description={
							<div className="space-y-4">
								<AlertBlock type="warning">
									Enabling deploys a managed OpenTelemetry Collector job on the
									cluster that scrapes services and ships metrics to the OTLP
									endpoint. Disabling stops and purges it.
								</AlertBlock>
								<p>Are you sure you want to save these settings?</p>
							</div>
						}
						onClick={async () => {
							try {
								await saveObservability({
									enabled,
									otlpEndpoint: otlpEndpoint.trim(),
									otlpHeaders: buildHeaders(),
									scrapeIntervalSeconds: scrapeNum,
									scrapeBearerToken: scrapeBearerToken.trim(),
								});
								toast.success(
									enabled
										? "Observability enabled. Collector deploying."
										: "Observability settings saved.",
								);
								refetch();
							} catch (error) {
								toast.error(
									(error as Error)?.message ||
										"Failed to save observability settings.",
								);
							}
						}}
						type="default"
						disabled={!canSave}
					>
						<Button
							variant="secondary"
							isLoading={isPending}
							disabled={!canSave}
						>
							Save
						</Button>
					</DialogAction>
				</div>
			</CardContent>
		</Card>
	);
};

export default Observability;
