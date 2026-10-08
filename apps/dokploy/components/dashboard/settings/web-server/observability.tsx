import { CheckCircle2, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";

type ScrapeAuth =
	| { type: "none" }
	| { type: "bearer"; scheme: string; credentials: string }
	| { type: "basic"; username: string; password: string };

type AuthProfile =
	| { name: string; type: "bearer"; scheme: string; credentials: string }
	| { name: string; type: "basic"; username: string; password: string };

// All fields held at once so switching type keeps what was typed.
type EditProfile = {
	name: string;
	type: "bearer" | "basic";
	scheme: string;
	credentials: string;
	username: string;
	password: string;
};

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

const emptyProfile = (): EditProfile => ({
	name: "",
	type: "bearer",
	scheme: "Bearer",
	credentials: "",
	username: "",
	password: "",
});

export const Observability = () => {
	const { data, refetch } = api.settings.getObservability.useQuery();
	const {
		data: status,
		refetch: refetchStatus,
		isRefetching: statusRefetching,
	} = api.settings.getObservabilityStatus.useQuery(undefined, {
		refetchInterval: 15000,
	});
	const { mutateAsync: saveObservability, isPending } =
		api.settings.saveObservability.useMutation();

	const [enabled, setEnabled] = useState(false);
	const [otlpEndpoint, setOtlpEndpoint] = useState("");
	const [headerKey, setHeaderKey] = useState("");
	const [headerValue, setHeaderValue] = useState("");
	const [scrapeInterval, setScrapeInterval] = useState("30");
	const [scrapeAuthType, setScrapeAuthType] = useState<
		"none" | "bearer" | "basic"
	>("none");
	const [scrapeScheme, setScrapeScheme] = useState("Bearer");
	const [scrapeCredentials, setScrapeCredentials] = useState("");
	const [scrapeUsername, setScrapeUsername] = useState("");
	const [scrapePassword, setScrapePassword] = useState("");
	const [profiles, setProfiles] = useState<EditProfile[]>([]);

	// Prefill ONCE, the first time the stored config loads. react-query refetches
	// on window focus / reconnect / after our own save, and re-syncing here would
	// clobber in-progress edits — notably flipping the Enable toggle back off
	// before Save captured it. The user's edits are the source of truth after
	// load; Save persists them and the collector status reflects the result.
	const prefilled = useRef(false);
	useEffect(() => {
		if (!data || prefilled.current) return;
		prefilled.current = true;
		setEnabled(data.enabled);
		setOtlpEndpoint(data.otlpEndpoint);
		setScrapeInterval(String(data.scrapeIntervalSeconds));
		const auth = data.scrapeAuth ?? { type: "none" };
		setScrapeAuthType(auth.type);
		if (auth.type === "bearer") {
			setScrapeScheme(auth.scheme || "Bearer");
			setScrapeCredentials(auth.credentials);
		} else if (auth.type === "basic") {
			setScrapeUsername(auth.username);
			setScrapePassword(auth.password);
		}
		setProfiles(
			(data.authProfiles ?? []).map((p) => ({
				...emptyProfile(),
				name: p.name,
				type: p.type,
				...(p.type === "bearer"
					? { scheme: p.scheme || "Bearer", credentials: p.credentials }
					: { username: p.username, password: p.password }),
			})),
		);
		const entries = Object.entries(data.otlpHeaders ?? {});
		if (entries[0]) {
			setHeaderKey(entries[0][0]);
			setHeaderValue(entries[0][1]);
		}
	}, [data]);

	const updateProfile = (i: number, patch: Partial<EditProfile>) =>
		setProfiles((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
	const removeProfile = (i: number) =>
		setProfiles((ps) => ps.filter((_, j) => j !== i));
	const addProfile = () => setProfiles((ps) => [...ps, emptyProfile()]);

	// Names must be unique, non-empty and regex-safe for the collector config.
	const trimmedNames = profiles.map((p) => p.name.trim());
	const profilesValid =
		trimmedNames.every((n) => PROFILE_NAME_RE.test(n)) &&
		new Set(trimmedNames).size === trimmedNames.length;

	const scrapeNum = Number(scrapeInterval);
	const scrapeValid =
		Number.isInteger(scrapeNum) && scrapeNum >= 5 && scrapeNum <= 3600;
	const endpointValid = !enabled || otlpEndpoint.trim().length > 0;
	const canSave = scrapeValid && endpointValid && profilesValid && !isPending;

	const buildHeaders = (): Record<string, string> => {
		const headers: Record<string, string> = {};
		const k = headerKey.trim();
		if (k.length > 0) {
			headers[k] = headerValue;
		}
		return headers;
	};

	const buildScrapeAuth = (): ScrapeAuth => {
		if (scrapeAuthType === "bearer") {
			return {
				type: "bearer",
				scheme: scrapeScheme.trim() || "Bearer",
				credentials: scrapeCredentials.trim(),
			};
		}
		if (scrapeAuthType === "basic") {
			return {
				type: "basic",
				username: scrapeUsername.trim(),
				password: scrapePassword,
			};
		}
		return { type: "none" };
	};

	const buildAuthProfiles = (): AuthProfile[] =>
		profiles
			.map((p): AuthProfile | null => {
				const name = p.name.trim();
				if (!PROFILE_NAME_RE.test(name)) return null;
				return p.type === "basic"
					? {
							name,
							type: "basic",
							username: p.username.trim(),
							password: p.password,
						}
					: {
							name,
							type: "bearer",
							scheme: p.scheme.trim() || "Bearer",
							credentials: p.credentials.trim(),
						};
			})
			.filter((p): p is AuthProfile => p !== null);

	const collector = status?.collector;
	const targets = status?.targets ?? [];

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-lg">Observability (OpenTelemetry)</CardTitle>
				<CardDescription>
					Run a managed OpenTelemetry Collector that discovers services via
					Consul and ships their Prometheus metrics to an OTLP backend (e.g.
					SigNoz). It scrapes services tagged{" "}
					<code>nomploy.metrics.port=&lt;port&gt;</code> plus the Traefik load
					balancer, and forwards everything to the OTLP endpoint.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<Tabs defaultValue="collector" className="w-full">
					<TabsList>
						<TabsTrigger value="collector">Collector</TabsTrigger>
						<TabsTrigger value="profiles">
							Auth profiles
							{profiles.length > 0 && (
								<Badge variant="secondary" className="ml-2">
									{profiles.length}
								</Badge>
							)}
						</TabsTrigger>
						<TabsTrigger value="targets">
							Targets
							{targets.length > 0 && (
								<Badge variant="secondary" className="ml-2">
									{targets.length}
								</Badge>
							)}
						</TabsTrigger>
					</TabsList>

					<TabsContent value="collector" className="flex flex-col gap-4 pt-4">
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

						<div className="flex flex-col gap-2">
							<Label htmlFor="otel-scrape-auth">Default scrape auth</Label>
							<Select
								value={scrapeAuthType}
								onValueChange={(v) =>
									setScrapeAuthType(v as "none" | "bearer" | "basic")
								}
							>
								<SelectTrigger id="otel-scrape-auth" className="sm:max-w-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="none">None</SelectItem>
									<SelectItem value="bearer">Bearer / token header</SelectItem>
									<SelectItem value="basic">Basic auth</SelectItem>
								</SelectContent>
							</Select>
							<span className="text-sm text-muted-foreground">
								Credential for tagged services that don't name an auth profile.
								For per-service tokens, use the Auth profiles tab. Never sent to
								the Traefik load balancer.
							</span>
						</div>

						{scrapeAuthType === "bearer" && (
							<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
								<div className="flex w-full flex-col gap-2 sm:max-w-[10rem]">
									<Label htmlFor="otel-scrape-scheme">Scheme</Label>
									<Input
										id="otel-scrape-scheme"
										placeholder="Bearer"
										value={scrapeScheme}
										onChange={(e) => setScrapeScheme(e.target.value)}
									/>
								</div>
								<div className="flex w-full flex-col gap-2">
									<Label htmlFor="otel-scrape-token">Token / credentials</Label>
									<Input
										id="otel-scrape-token"
										type="password"
										placeholder="Sent as Authorization: <scheme> <token>"
										value={scrapeCredentials}
										onChange={(e) => setScrapeCredentials(e.target.value)}
									/>
								</div>
							</div>
						)}

						{scrapeAuthType === "basic" && (
							<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
								<div className="flex w-full flex-col gap-2">
									<Label htmlFor="otel-scrape-user">Username</Label>
									<Input
										id="otel-scrape-user"
										value={scrapeUsername}
										onChange={(e) => setScrapeUsername(e.target.value)}
									/>
								</div>
								<div className="flex w-full flex-col gap-2">
									<Label htmlFor="otel-scrape-pass">Password</Label>
									<Input
										id="otel-scrape-pass"
										type="password"
										value={scrapePassword}
										onChange={(e) => setScrapePassword(e.target.value)}
									/>
								</div>
							</div>
						)}

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
					</TabsContent>

					<TabsContent value="profiles" className="flex flex-col gap-3 pt-4">
						<div className="flex items-center justify-between gap-4">
							<span className="text-sm text-muted-foreground">
								Named credentials a service selects by name (its metrics "Auth
								profile"), so each service can be scraped with its own token.
								Tokens stay here, never in Consul. The collector runs one scrape
								job per profile.
							</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={addProfile}
							>
								<Plus className="mr-1 size-4" /> Add
							</Button>
						</div>

						{profiles.length === 0 && (
							<span className="text-sm text-muted-foreground">
								No profiles yet.
							</span>
						)}

						{profiles.map((p, i) => {
							const name = p.name.trim();
							const dupe =
								name !== "" &&
								trimmedNames.filter((n) => n === name).length > 1;
							const badName = name !== "" && !PROFILE_NAME_RE.test(name);
							return (
								<div
									key={i}
									className="flex flex-col gap-2 rounded-md border p-3"
								>
									<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
										<div className="flex w-full flex-col gap-2 sm:max-w-[12rem]">
											<Label>Name</Label>
											<Input
												placeholder="e.g. goliash"
												value={p.name}
												onChange={(e) =>
													updateProfile(i, { name: e.target.value })
												}
											/>
										</div>
										<div className="flex w-full flex-col gap-2 sm:max-w-[12rem]">
											<Label>Type</Label>
											<Select
												value={p.type}
												onValueChange={(v) =>
													updateProfile(i, { type: v as "bearer" | "basic" })
												}
											>
												<SelectTrigger>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="bearer">
														Bearer / token header
													</SelectItem>
													<SelectItem value="basic">Basic auth</SelectItem>
												</SelectContent>
											</Select>
										</div>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="text-muted-foreground"
											onClick={() => removeProfile(i)}
										>
											<Trash2 className="size-4" />
										</Button>
									</div>

									{(dupe || badName) && (
										<span className="text-sm text-destructive">
											{badName
												? "Use only letters, numbers, dashes and underscores."
												: "Duplicate profile name."}
										</span>
									)}

									{p.type === "bearer" ? (
										<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
											<div className="flex w-full flex-col gap-2 sm:max-w-[10rem]">
												<Label>Scheme</Label>
												<Input
													placeholder="Bearer"
													value={p.scheme}
													onChange={(e) =>
														updateProfile(i, { scheme: e.target.value })
													}
												/>
											</div>
											<div className="flex w-full flex-col gap-2">
												<Label>Token / credentials</Label>
												<Input
													type="password"
													placeholder="Sent as Authorization: <scheme> <token>"
													value={p.credentials}
													onChange={(e) =>
														updateProfile(i, { credentials: e.target.value })
													}
												/>
											</div>
										</div>
									) : (
										<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
											<div className="flex w-full flex-col gap-2">
												<Label>Username</Label>
												<Input
													value={p.username}
													onChange={(e) =>
														updateProfile(i, { username: e.target.value })
													}
												/>
											</div>
											<div className="flex w-full flex-col gap-2">
												<Label>Password</Label>
												<Input
													type="password"
													value={p.password}
													onChange={(e) =>
														updateProfile(i, { password: e.target.value })
													}
												/>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</TabsContent>

					<TabsContent value="targets" className="flex flex-col gap-4 pt-4">
						<div className="flex items-center justify-between gap-3">
							<div className="flex items-center gap-2 text-sm">
								<span className="text-muted-foreground">Collector:</span>
								{collector?.deployed ? (
									<Badge className="gap-1" variant="secondary">
										<CheckCircle2 className="size-3.5 text-green-500" />
										{collector.status ?? "running"} · {collector.runningAllocs}{" "}
										alloc
										{collector.runningAllocs === 1 ? "" : "s"}
									</Badge>
								) : (
									<Badge className="gap-1" variant="secondary">
										<XCircle className="size-3.5 text-muted-foreground" />
										not deployed
									</Badge>
								)}
							</div>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => refetchStatus()}
								disabled={statusRefetching}
							>
								<RefreshCw
									className={`mr-1 size-4 ${statusRefetching ? "animate-spin" : ""}`}
								/>
								Refresh
							</Button>
						</div>

						<div className="flex flex-col gap-1">
							<Label>Discovered targets</Label>
							<span className="text-sm text-muted-foreground">
								Services the collector scrapes, discovered from Consul by the{" "}
								<code>nomploy.metrics.port</code> tag. The Traefik load balancer
								is scraped separately.
							</span>
						</div>

						{targets.length === 0 ? (
							<span className="text-sm text-muted-foreground">
								No services are tagged for metrics yet. Set a metrics port on an
								app (Advanced → Metrics) or a pack to add one.
							</span>
						) : (
							<div className="overflow-hidden rounded-md border">
								<table className="w-full text-sm">
									<thead className="bg-muted/50 text-muted-foreground">
										<tr>
											<th className="px-3 py-2 text-left font-medium">
												Service
											</th>
											<th className="px-3 py-2 text-left font-medium">
												Target
											</th>
											<th className="px-3 py-2 text-left font-medium">
												Auth profile
											</th>
										</tr>
									</thead>
									<tbody>
										{targets.map((t) => (
											<tr
												key={`${t.service}-${t.address}-${t.port}`}
												className="border-t"
											>
												<td className="px-3 py-2 font-medium">{t.service}</td>
												<td className="px-3 py-2 font-mono text-xs">
													{t.address}:{t.port}
												</td>
												<td className="px-3 py-2">
													{t.authProfile ? (
														<Badge variant="outline">{t.authProfile}</Badge>
													) : (
														<span className="text-muted-foreground">
															default
														</span>
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</TabsContent>
				</Tabs>

				<div className="flex justify-end border-t pt-4">
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
									scrapeAuth: buildScrapeAuth(),
									authProfiles: buildAuthProfiles(),
								});
								toast.success(
									enabled
										? "Observability enabled. Collector deploying."
										: "Observability settings saved.",
								);
								refetch();
								// Collector + targets change after a save; poll status a few
								// times so the Targets tab reflects the new state promptly.
								setTimeout(() => refetchStatus(), 2000);
								setTimeout(() => refetchStatus(), 6000);
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
