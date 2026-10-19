import { LayoutGrid } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

/**
 * One-click Goliash integration. Deploys goliash as a panel-owned Nomad job that
 * watches this cluster read-only and renders its services as tiles, with all the
 * fiddly wiring done automatically: a minted read-only Nomad token, hub DNS for
 * Consul names, SQLite pinned to the hub (or a Postgres DSN), a Traefik route +
 * TLS for the public URL, and optional metrics scraping.
 */
export const ShowGoliash = () => {
	const { data, refetch } = api.settings.getGoliash.useQuery();
	const { mutateAsync, isPending } = api.settings.saveGoliash.useMutation();

	const [enabled, setEnabled] = useState(false);
	const [publicUrl, setPublicUrl] = useState("");
	const [ownerEmail, setOwnerEmail] = useState("");
	const [environment, setEnvironment] = useState("prod");
	const [image, setImage] = useState("");
	const [databaseUrl, setDatabaseUrl] = useState("");
	const [metricsEnabled, setMetricsEnabled] = useState(false);
	const [metricsAuthProfile, setMetricsAuthProfile] = useState("");

	const prefilled = useRef(false);
	useEffect(() => {
		if (!data || prefilled.current) return;
		setEnabled(data.enabled);
		setPublicUrl(data.publicUrl ?? "");
		setOwnerEmail(data.ownerEmail ?? "");
		setEnvironment(data.environment ?? "prod");
		setImage(data.image ?? "");
		setDatabaseUrl(data.databaseUrl ?? "");
		setMetricsEnabled(data.metricsEnabled ?? false);
		setMetricsAuthProfile(data.metricsAuthProfile ?? "");
		prefilled.current = true;
	}, [data]);

	const save = async (nextEnabled: boolean) => {
		if (nextEnabled && !publicUrl.trim()) {
			toast.error("Set a public URL first (e.g. https://goliash.example.com)");
			return;
		}
		if (nextEnabled && !ownerEmail.trim()) {
			toast.error("Set an owner e-mail first");
			return;
		}
		try {
			await mutateAsync({
				enabled: nextEnabled,
				publicUrl: publicUrl.trim(),
				ownerEmail: ownerEmail.trim(),
				environment: environment.trim() || "prod",
				image: image.trim(),
				databaseUrl: databaseUrl.trim(),
				metricsEnabled,
				metricsAuthProfile: metricsAuthProfile.trim(),
			});
			setEnabled(nextEnabled);
			toast.success(
				nextEnabled ? "Goliash enabled — deploying" : "Goliash disabled",
			);
			await refetch();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<LayoutGrid className="size-5" />
					Goliash
				</CardTitle>
				<CardDescription>
					Deploy Goliash to watch this Nomad cluster read-only and show its
					services as a version × environment matrix. The integration wires it
					up for you — a read-only Nomad token, hub DNS, storage, a TLS route —
					so you don't touch pack variables.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<AlertBlock type="info">
					Point the public URL's hostname at this cluster's load balancer (CNAME
					to the LB DNS name). Goliash gets a certificate the same way your apps
					do. Leave Postgres empty to run on SQLite pinned to the hub node.
				</AlertBlock>

				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex flex-col gap-1">
						<Label className="text-base">Enabled</Label>
						<span className="text-sm text-muted-foreground">
							Deploy the goliash job + its route, and mint a read-only Nomad
							token for it.
						</span>
					</div>
					<Switch
						checked={enabled}
						onCheckedChange={save}
						disabled={isPending}
					/>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label>Public URL</Label>
						<Input
							placeholder="https://goliash.example.com"
							value={publicUrl}
							onChange={(e) => setPublicUrl(e.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							Where people reach Goliash. Also the Traefik Host + TLS cert.
						</p>
					</div>
					<div className="space-y-1.5">
						<Label>Owner e-mail</Label>
						<Input
							placeholder="you@example.com"
							value={ownerEmail}
							onChange={(e) => setOwnerEmail(e.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							First owner; a one-time sign-in link is logged until they sign in.
						</p>
					</div>
					<div className="space-y-1.5">
						<Label>Environment name</Label>
						<Input
							placeholder="prod"
							value={environment}
							onChange={(e) => setEnvironment(e.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							How this cluster is labelled in Goliash (e.g. prod / staging).
						</p>
					</div>
					<div className="space-y-1.5">
						<Label>Image</Label>
						<Input
							placeholder="ghcr.io/pipozzz/goliash:1.20.0"
							value={image}
							onChange={(e) => setImage(e.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							Pin a tag. Empty = the bundled default.
						</p>
					</div>
					<div className="space-y-1.5 sm:col-span-2">
						<Label>Postgres DSN (optional)</Label>
						<Input
							placeholder="postgres://user:pass@host:5432/goliash"
							value={databaseUrl}
							onChange={(e) => setDatabaseUrl(e.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							Run stateless on Postgres instead of the hub-pinned SQLite volume.
							Resolve a Consul name via the hub DNS that's already wired.
						</p>
					</div>
				</div>

				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex flex-col gap-1">
						<Label className="text-base">Scrape metrics</Label>
						<span className="text-sm text-muted-foreground">
							Expose Goliash's /metrics to the built-in OTel Collector (needs a
							Bearer auth profile with a glsh_api_ token).
						</span>
					</div>
					<Switch checked={metricsEnabled} onCheckedChange={setMetricsEnabled} />
				</div>
				{metricsEnabled && (
					<div className="space-y-1.5 sm:max-w-xs">
						<Label>Metrics auth profile</Label>
						<Input
							placeholder="goliash"
							value={metricsAuthProfile}
							onChange={(e) => setMetricsAuthProfile(e.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							Name of an OTel scrape auth profile (Observability → profiles).
						</p>
					</div>
				)}

				<div>
					<Button
						type="button"
						onClick={() => save(enabled)}
						disabled={isPending}
					>
						Save
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
