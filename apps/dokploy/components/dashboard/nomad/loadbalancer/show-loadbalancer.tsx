import {
	Activity,
	Check,
	Copy,
	Globe,
	Loader2,
	Network,
	RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { api } from "@/utils/api";

const statusBadge = (ok: boolean) =>
	ok
		? "border-emerald-500/40 text-emerald-500"
		: "border-destructive/40 text-destructive";

/**
 * The Traefik ingress pool: deploy/stop/redeploy + shared-cert sync + members.
 */
const PoolCard = ({ canManage }: { canManage: boolean }) => {
	const { data, refetch, isPending } = api.nomad.getLoadBalancerStatus.useQuery(
		undefined,
		{ refetchInterval: 10000 },
	);
	const { data: nodes } = api.nomad.getLoadBalancerNodes.useQuery(undefined, {
		refetchInterval: 10000,
	});
	const deploy = api.nomad.deployLoadBalancer.useMutation();
	const stop = api.nomad.stopLoadBalancer.useMutation();
	const syncCerts = api.nomad.syncLoadBalancerCerts.useMutation();

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="flex flex-col gap-0.5">
					<CardTitle className="flex flex-row gap-2 text-xl">
						<Network className="size-5 self-center text-muted-foreground" />
						Ingress pool
					</CardTitle>
					<CardDescription>
						Traefik on every node tagged <code>nomploy_lb=true</code> —
						active/active (the hub is excluded). Members serve routes from the
						Consul catalog and shared certs from Consul KV.
					</CardDescription>
				</div>
				{canManage && (
					<div className="flex flex-row gap-2">
						<Button
							size="sm"
							isLoading={deploy.isPending}
							onClick={async () => {
								await deploy
									.mutateAsync()
									.then(async (r) => {
										toast.success("Load balancer deployed", {
											description: `${r.certCount} cert(s) synced to the shared store`,
										});
										await refetch();
									})
									.catch((e) =>
										toast.error("Deploy failed", { description: e.message }),
									);
							}}
						>
							{data?.deployed ? "Redeploy" : "Deploy"}
						</Button>
						{data?.deployed && (
							<Button
								size="sm"
								variant="outline"
								isLoading={syncCerts.isPending}
								onClick={async () => {
									await syncCerts
										.mutateAsync()
										.then((r) =>
											toast.success("Certs synced", {
												description: `${r.certCount} cert(s) refreshed in the shared store`,
											}),
										)
										.catch((e) =>
											toast.error("Cert sync failed", {
												description: e.message,
											}),
										);
								}}
							>
								Sync certs
							</Button>
						)}
						{data?.deployed && (
							<DialogAction
								title="Stop load balancer"
								description="Removes the Traefik HA pool from every tagged node. The hub's standalone Traefik keeps serving. Continue?"
								type="destructive"
								onClick={async () => {
									await stop
										.mutateAsync()
										.then(async () => {
											toast.success("Load balancer stopped");
											await refetch();
										})
										.catch((e) =>
											toast.error("Stop failed", { description: e.message }),
										);
								}}
							>
								<Button size="sm" variant="outline" isLoading={stop.isPending}>
									Stop
								</Button>
							</DialogAction>
						)}
					</div>
				)}
			</CardHeader>
			<CardContent>
				{isPending ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="size-4 animate-spin" /> Loading…
					</div>
				) : !data?.deployed ? (
					<p className="text-muted-foreground text-sm">
						Not deployed. Tag the server nodes you want in the pool with{" "}
						<code>nomploy_lb=true</code>, then Deploy. (The hub is intentionally
						excluded.)
					</p>
				) : (
					<div className="flex flex-col gap-2">
						{(
							nodes ??
							data.members.map((m) => ({ ...m, ip: null, publicIp: null }))
						).map((m) => (
							<div
								key={m.node}
								className="flex items-center justify-between rounded-lg border p-2.5 text-sm"
							>
								<div className="flex flex-col">
									<span className="font-medium">{m.node}</span>
									{"publicIp" in m && (m.publicIp || m.ip) && (
										<span className="text-muted-foreground text-xs">
											{m.publicIp || m.ip}
										</span>
									)}
								</div>
								<Badge
									variant="outline"
									className={statusBadge(m.status === "running")}
								>
									{m.status}
								</Badge>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
};

const CopyButton = ({ value }: { value: string }) => {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			size="sm"
			variant="outline"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(value);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				} catch {
					toast.error("Could not copy");
				}
			}}
		>
			{copied ? (
				<Check className="size-4 text-emerald-500" />
			) : (
				<Copy className="size-4" />
			)}
		</Button>
	);
};

/**
 * DNS entry to the pool: a generated hostname whose A records track the healthy
 * nodes' public IPs (health-prune). Users CNAME their app domains to it.
 */
const DnsCard = ({ canManage }: { canManage: boolean }) => {
	const { data, refetch, isPending } =
		api.nomad.getLoadBalancerConfig.useQuery();
	const [providerId, setProviderId] = useState<string>("");
	const [zone, setZone] = useState<string>("");
	const [ttl, setTtl] = useState<number>(60);

	const zonesQ = api.nomad.listLoadBalancerZones.useQuery(
		{ dnsProviderId: providerId },
		{ enabled: !!providerId },
	);
	const upsert = api.nomad.upsertLoadBalancerConfig.useMutation();
	const toggle = api.nomad.setLoadBalancerDnsEnabled.useMutation();
	const reconcile = api.nomad.reconcileLoadBalancerDns.useMutation();

	const cfg = data?.config;
	const providers = data?.dnsProviders ?? [];

	// Seed the local form from the saved config once loaded.
	useEffect(() => {
		if (cfg) {
			setProviderId((p) => p || cfg.dnsProviderId || "");
			setTtl(cfg.ttl);
		}
	}, [cfg]);

	if (isPending) {
		return (
			<Card className="bg-background">
				<CardContent className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
					<Loader2 className="size-4 animate-spin" /> Loading DNS…
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="flex flex-col gap-0.5">
					<CardTitle className="flex flex-row gap-2 text-xl">
						<Globe className="size-5 self-center text-muted-foreground" />
						DNS
					</CardTitle>
					<CardDescription>
						A generated hostname whose A records are kept equal to the healthy
						pool nodes' public IPs (fast DNS failover). Point your app domains
						at it with a CNAME.
					</CardDescription>
				</div>
				{cfg && (
					<Badge variant="outline" className={statusBadge(cfg.enabled)}>
						{cfg.enabled ? "DNS managed" : "DNS off"}
					</Badge>
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{providers.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No DNS provider yet. Add one in{" "}
						<Link
							href="/dashboard/settings/dns-providers"
							className="text-primary underline"
						>
							Settings → DNS Providers
						</Link>{" "}
						first.
					</p>
				) : (
					<>
						{/* Setup / provider + zone selection */}
						{canManage && (
							<div className="flex flex-col gap-3 rounded-lg border p-3">
								<div className="grid gap-3 sm:grid-cols-3">
									<div className="flex flex-col gap-1.5">
										<Label>DNS provider</Label>
										<Select
											value={providerId}
											onValueChange={(v) => {
												setProviderId(v);
												setZone("");
											}}
										>
											<SelectTrigger>
												<SelectValue placeholder="Select provider" />
											</SelectTrigger>
											<SelectContent>
												{providers.map((p) => (
													<SelectItem
														key={p.dnsProviderId}
														value={p.dnsProviderId}
													>
														{p.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="flex flex-col gap-1.5">
										<Label>Zone</Label>
										<Select
											value={zone}
											onValueChange={setZone}
											disabled={!providerId || zonesQ.isPending}
										>
											<SelectTrigger>
												<SelectValue
													placeholder={
														zonesQ.isPending ? "Loading…" : "Auto (first zone)"
													}
												/>
											</SelectTrigger>
											<SelectContent>
												{(zonesQ.data ?? []).map((z) => (
													<SelectItem key={z.id} value={z.name}>
														{z.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="flex flex-col gap-1.5">
										<Label>TTL (s)</Label>
										<Input
											type="number"
											value={ttl}
											min={1}
											onChange={(e) => setTtl(Number(e.target.value) || 60)}
										/>
									</div>
								</div>
								<div>
									<Button
										size="sm"
										isLoading={upsert.isPending}
										disabled={!providerId}
										onClick={async () => {
											await upsert
												.mutateAsync({
													dnsProviderId: providerId,
													zoneName: zone || undefined,
													ttl,
												})
												.then(async (r) => {
													toast.success("DNS configured", {
														description: r.hostname,
													});
													await refetch();
												})
												.catch((e) =>
													toast.error("Setup failed", {
														description: e.message,
													}),
												);
										}}
									>
										{cfg ? "Update" : "Generate hostname"}
									</Button>
								</div>
							</div>
						)}

						{/* Current config */}
						{cfg && (
							<div className="flex flex-col gap-3">
								<div className="flex items-center gap-2">
									<code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">
										{cfg.hostname}
									</code>
									<CopyButton value={cfg.hostname} />
								</div>
								<p className="text-muted-foreground text-xs">
									CNAME your app domains to <strong>{cfg.hostname}</strong>. The
									pool already serves their routes + certs.
								</p>

								<div className="flex flex-wrap items-center gap-4 rounded-lg border p-3">
									<div className="flex items-center gap-2">
										<Switch
											checked={cfg.enabled}
											disabled={!canManage || toggle.isPending}
											onCheckedChange={async (enabled) => {
												await toggle
													.mutateAsync({ enabled })
													.then(async (r) => {
														toast.success(
															enabled
																? `DNS management on — ${r.desired.length} node(s) in DNS`
																: "DNS management off — records cleared",
														);
														await refetch();
													})
													.catch((e) =>
														toast.error("Toggle failed", {
															description: e.message,
														}),
													);
											}}
										/>
										<span className="text-sm">
											Manage DNS (health-prune A records)
										</span>
									</div>
									{canManage && cfg.enabled && (
										<Button
											size="sm"
											variant="outline"
											isLoading={reconcile.isPending}
											onClick={async () => {
												await reconcile
													.mutateAsync()
													.then(async (r) => {
														toast.success(
															`Reconciled — ${r.desired.length} node(s) in DNS`,
															{
																description:
																	r.created.length || r.removed.length
																		? `+${r.created.length} / -${r.removed.length}`
																		: "no change",
															},
														);
														await refetch();
													})
													.catch((e) =>
														toast.error("Reconcile failed", {
															description: e.message,
														}),
													);
											}}
										>
											<RefreshCw className="mr-1 size-4" /> Reconcile now
										</Button>
									)}
									{cfg.lastReconcileAt && (
										<span className="text-muted-foreground text-xs">
											Last: {new Date(cfg.lastReconcileAt).toLocaleString()} —{" "}
											{cfg.lastReconcileStatus}
										</span>
									)}
								</div>
							</div>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
};

/** Per-node Traefik metrics: request rate, status classes, latency, in-DNS. */
const MetricsCard = () => {
	const { data, isPending } = api.nomad.getLoadBalancerMetrics.useQuery(
		undefined,
		{ refetchInterval: 10000 },
	);

	const totals = (data ?? []).reduce(
		(acc, n) => ({
			requests: acc.requests + n.requests,
			reqPerSec: acc.reqPerSec + n.reqPerSec,
			req5xx: acc.req5xx + n.req5xx,
		}),
		{ requests: 0, reqPerSec: 0, req5xx: 0 },
	);

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex flex-row gap-2 text-xl">
					<Activity className="size-5 self-center text-muted-foreground" />
					Metrics
				</CardTitle>
				<CardDescription>
					Live Traefik metrics per pool node (Prometheus). Rate is measured
					between refreshes.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{isPending ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="size-4 animate-spin" /> Loading metrics…
					</div>
				) : (data ?? []).length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No pool nodes running yet.
					</p>
				) : (
					<div className="flex flex-col gap-4">
						<div className="grid grid-cols-3 gap-3">
							<Stat label="Requests/s" value={totals.reqPerSec.toFixed(1)} />
							<Stat
								label="Total requests"
								value={totals.requests.toLocaleString()}
							/>
							<Stat
								label="5xx"
								value={totals.req5xx.toLocaleString()}
								danger={totals.req5xx > 0}
							/>
						</div>
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="text-left text-muted-foreground text-xs">
										<th className="py-1.5 pr-3 font-medium">Node</th>
										<th className="py-1.5 pr-3 font-medium">Health</th>
										<th className="py-1.5 pr-3 font-medium">In DNS</th>
										<th className="py-1.5 pr-3 text-right font-medium">
											req/s
										</th>
										<th className="py-1.5 pr-3 text-right font-medium">2xx</th>
										<th className="py-1.5 pr-3 text-right font-medium">4xx</th>
										<th className="py-1.5 pr-3 text-right font-medium">5xx</th>
										<th className="py-1.5 pr-3 text-right font-medium">
											Latency
										</th>
									</tr>
								</thead>
								<tbody>
									{(data ?? []).map((n) => (
										<tr key={n.node} className="border-t">
											<td className="py-1.5 pr-3">
												<div className="flex flex-col">
													<span className="font-medium">{n.node}</span>
													{n.ip && (
														<span className="text-muted-foreground text-xs">
															{n.ip}
														</span>
													)}
												</div>
											</td>
											<td className="py-1.5 pr-3">
												<Badge
													variant="outline"
													className={statusBadge(n.healthy && n.reachable)}
												>
													{n.healthy
														? n.reachable
															? "up"
															: "no metrics"
														: "down"}
												</Badge>
											</td>
											<td className="py-1.5 pr-3">
												{n.inDns ? (
													<Check className="size-4 text-emerald-500" />
												) : (
													<span className="text-muted-foreground">—</span>
												)}
											</td>
											<td className="py-1.5 pr-3 text-right tabular-nums">
												{n.reqPerSec.toFixed(1)}
											</td>
											<td className="py-1.5 pr-3 text-right tabular-nums">
												{n.req2xx.toLocaleString()}
											</td>
											<td className="py-1.5 pr-3 text-right tabular-nums">
												{n.req4xx.toLocaleString()}
											</td>
											<td
												className={`py-1.5 pr-3 text-right tabular-nums ${
													n.req5xx > 0 ? "text-destructive" : ""
												}`}
											>
												{n.req5xx.toLocaleString()}
											</td>
											<td className="py-1.5 pr-3 text-right tabular-nums">
												{n.avgLatencyMs.toFixed(0)} ms
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
};

const Stat = ({
	label,
	value,
	danger,
}: {
	label: string;
	value: string;
	danger?: boolean;
}) => (
	<div className="rounded-lg border p-3">
		<div className="text-muted-foreground text-xs">{label}</div>
		<div
			className={`font-semibold text-lg tabular-nums ${
				danger ? "text-destructive" : ""
			}`}
		>
			{value}
		</div>
	</div>
);

export const ShowLoadBalancer = () => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canManage = !!permissions?.server?.create;
	return (
		<div className="flex flex-col gap-4">
			<PoolCard canManage={canManage} />
			<DnsCard canManage={canManage} />
			<MetricsCard />
		</div>
	);
};
