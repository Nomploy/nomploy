import {
	CheckCircle2,
	Dices,
	Plus,
	RefreshCw,
	Trash2,
	XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
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
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
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

type ThroughputPoint = {
	t: number;
	received: number;
	sent: number;
	failed: number;
};
const MAX_TP_POINTS = 60;
const throughputConfig = {
	received: { label: "Scraped /s", color: "hsl(var(--chart-1))" },
	sent: { label: "Exported /s", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig;

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

/**
 * A random, hard-to-guess profile name. The name ends up in a public Consul tag
 * (`nomploy.metrics.auth=<name>`); a guessable name would let a rogue workload
 * self-tag with it and make the collector scrape it using this profile's token,
 * leaking the credential. A random suffix makes that impractical.
 */
const genProfileName = (): string => {
	let rand = "";
	try {
		const b = new Uint8Array(6);
		crypto.getRandomValues(b);
		rand = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
	} catch {
		rand = Math.random().toString(36).slice(2, 14);
	}
	return `scrape-${rand}`;
};

const emptyProfile = (): EditProfile => ({
	name: genProfileName(),
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
	const {
		data: logs,
		refetch: refetchLogs,
		isRefetching: logsRefetching,
	} = api.settings.getObservabilityLogs.useQuery(
		{ lines: 300 },
		{ refetchInterval: 15000 },
	);
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
	const [shipNomadMetrics, setShipNomadMetrics] = useState(false);
	const [shipLoadBalancerLogs, setShipLoadBalancerLogs] = useState(false);
	const [shipServiceLogs, setShipServiceLogs] = useState(false);

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
		setShipNomadMetrics(!!data.shipNomadMetrics);
		setShipLoadBalancerLogs(!!data.shipLoadBalancerLogs);
		setShipServiceLogs(!!data.shipServiceLogs);
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

	// Live throughput: keep a rolling window of the collector's cumulative
	// counters across polls, then diff consecutive samples into points/sec. No
	// history before the page was opened (the counters live only in the
	// collector); resets if the collector restarts (counters go backwards).
	const [tpHistory, setTpHistory] = useState<ThroughputPoint[]>([]);
	const points = collector?.points ?? null;
	useEffect(() => {
		if (!points) return;
		setTpHistory((prev) => {
			if (prev.length > 0 && prev[prev.length - 1]?.t === points.at)
				return prev;
			return [
				...prev,
				{
					t: points.at,
					received: points.received,
					sent: points.sent,
					failed: points.failed,
				},
			].slice(-MAX_TP_POINTS);
		});
	}, [points]);

	const tpData = tpHistory.flatMap((cur, i) => {
		const prev = tpHistory[i - 1];
		if (!prev) return [];
		const dt = Math.max(1, (cur.t - prev.t) / 1000);
		const rate = (a: number, b: number) => Math.max(0, (a - b) / dt);
		return [
			{
				t: cur.t,
				received: Number(rate(cur.received, prev.received).toFixed(2)),
				sent: Number(rate(cur.sent, prev.sent).toFixed(2)),
				failed: Number(rate(cur.failed, prev.failed).toFixed(2)),
			},
		];
	});

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
						<TabsTrigger value="logs">Logs</TabsTrigger>
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
									type="password"
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

						<div className="flex flex-col gap-3 rounded-lg border p-3">
							<Label>Signals to ship</Label>
							<div className="flex items-center justify-between gap-4">
								<div className="flex flex-col gap-0.5">
									<span className="text-sm">Nomad / platform metrics</span>
									<span className="text-xs text-muted-foreground">
										Scrape the cluster's own Nomad metrics (
										<code>/v1/metrics</code> on every node) into SigNoz — raft,
										scheduler, client &amp; runtime health.
									</span>
								</div>
								<Switch
									checked={shipNomadMetrics}
									onCheckedChange={setShipNomadMetrics}
								/>
							</div>
							<div className="flex items-center justify-between gap-4">
								<div className="flex flex-col gap-0.5">
									<span className="text-sm">Service logs</span>
									<span className="text-xs text-muted-foreground">
										Ship every service's stdout/stderr to SigNoz via a per-node
										log agent (tails Nomad alloc logs). Tagged with service
										name, alloc &amp; node.
									</span>
								</div>
								<Switch
									checked={shipServiceLogs}
									onCheckedChange={setShipServiceLogs}
								/>
							</div>
							<div className="flex items-center justify-between gap-4">
								<div className="flex flex-col gap-0.5">
									<span className="text-sm">Load balancer logs</span>
									<span className="text-xs text-muted-foreground">
										Ship the HA pool Traefik's access logs to SigNoz as{" "}
										<strong>structured</strong> records (status, latency, host,
										client IP) via native OTLP. Reconfigures the pool Traefik
										(rolling, auto-revert-safe).
									</span>
								</div>
								<Switch
									checked={shipLoadBalancerLogs}
									onCheckedChange={setShipLoadBalancerLogs}
								/>
							</div>
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
										<div className="flex w-full flex-col gap-2 sm:max-w-[14rem]">
											<Label>Name</Label>
											<div className="flex items-center gap-1">
												<Input
													placeholder="scrape-xxxx"
													value={p.name}
													onChange={(e) =>
														updateProfile(i, { name: e.target.value })
													}
												/>
												<Button
													type="button"
													variant="outline"
													size="icon"
													title="Generate a random, hard-to-guess name"
													onClick={() =>
														updateProfile(i, { name: genProfileName() })
													}
												>
													<Dices className="size-4" />
												</Button>
											</div>
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
								{collector?.node && (
									<span className="text-muted-foreground">
										on <span className="font-mono">{collector.node}</span>
									</span>
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
						{collector?.image && (
							<span className="font-mono text-xs text-muted-foreground">
								{collector.image}
							</span>
						)}

						{points && (
							<div className="flex flex-col gap-2 rounded-lg border p-3">
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<Label>Throughput</Label>
									<div className="flex gap-4 text-sm">
										<span>
											<span className="font-semibold">
												{tpData.length > 0
													? (tpData[tpData.length - 1]?.received ?? 0)
													: 0}
											</span>
											<span className="text-muted-foreground"> scraped/s</span>
										</span>
										<span>
											<span className="font-semibold">
												{tpData.length > 0
													? (tpData[tpData.length - 1]?.sent ?? 0)
													: 0}
											</span>
											<span className="text-muted-foreground"> exported/s</span>
										</span>
										{points.failed > 0 && (
											<span className="text-destructive">
												{points.failed} export failures
											</span>
										)}
									</div>
								</div>
								{tpData.length < 2 ? (
									<span className="text-sm text-muted-foreground">
										Collecting… the live graph builds up over the next polls.
									</span>
								) : (
									<ChartContainer
										config={throughputConfig}
										className="h-[160px] w-full"
									>
										<AreaChart data={tpData}>
											<CartesianGrid vertical={false} />
											<XAxis
												dataKey="t"
												tickLine={false}
												axisLine={false}
												tickMargin={8}
												minTickGap={40}
												tickFormatter={(v) =>
													new Date(v).toLocaleTimeString([], {
														hour: "2-digit",
														minute: "2-digit",
													})
												}
											/>
											<YAxis
												tickLine={false}
												axisLine={false}
												width={32}
												allowDecimals={false}
											/>
											<ChartTooltip content={<ChartTooltipContent />} />
											<Area
												type="monotone"
												dataKey="received"
												stroke="var(--color-received)"
												fill="var(--color-received)"
												fillOpacity={0.15}
												strokeWidth={2}
												isAnimationActive={false}
											/>
											<Area
												type="monotone"
												dataKey="sent"
												stroke="var(--color-sent)"
												fill="var(--color-sent)"
												fillOpacity={0.15}
												strokeWidth={2}
												isAnimationActive={false}
											/>
										</AreaChart>
									</ChartContainer>
								)}
								<span className="text-xs text-muted-foreground">
									Metric points the collector scrapes vs exports to the OTLP
									backend, per second. Live from the collector's own telemetry;
									history starts when you open this page.
								</span>
							</div>
						)}

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
												Health
											</th>
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
												<td className="px-3 py-2">
													{t.healthy === true ? (
														<span className="flex items-center gap-1 text-green-600 dark:text-green-500">
															<CheckCircle2 className="size-3.5" /> up
														</span>
													) : t.healthy === false ? (
														<span className="flex items-center gap-1 text-destructive">
															<XCircle className="size-3.5" /> failing
														</span>
													) : (
														<span className="text-muted-foreground">—</span>
													)}
												</td>
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
						{targets.some((t) => t.healthy === false) && (
							<AlertBlock type="warning">
								A failing target usually means the wrong (or missing) auth
								profile, or the service isn't serving <code>/metrics</code> on
								the tagged port. Check the Logs tab for the exact error.
							</AlertBlock>
						)}
					</TabsContent>

					<TabsContent value="logs" className="flex flex-col gap-3 pt-4">
						<div className="flex items-center justify-between gap-3">
							<span className="text-sm text-muted-foreground">
								Live collector output{" "}
								{logs?.allocId && (
									<span className="font-mono">
										· alloc {logs.allocId.slice(0, 8)}
									</span>
								)}
								. Scrape/export errors show here (e.g. a 401 on a service's{" "}
								<code>/metrics</code> means the wrong auth profile).
							</span>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => refetchLogs()}
								disabled={logsRefetching}
							>
								<RefreshCw
									className={`mr-1 size-4 ${logsRefetching ? "animate-spin" : ""}`}
								/>
								Refresh
							</Button>
						</div>
						<pre className="max-h-[28rem] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
							{logs?.logs || "No logs yet."}
						</pre>
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
									shipNomadMetrics,
									shipLoadBalancerLogs,
									shipServiceLogs,
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
