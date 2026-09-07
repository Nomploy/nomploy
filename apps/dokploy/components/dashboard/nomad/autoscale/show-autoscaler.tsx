import { Gauge, Loader2, RefreshCw, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

type Form = {
	enabled: boolean;
	provider: string;
	token: string;
	sshKeyId: string;
	serverType: string;
	location: string;
	image: string;
	networkId: string;
	minNodes: number;
	maxNodes: number;
	scaleUpThreshold: number;
	scaleDownThreshold: number;
	memScaleUpThreshold: number;
	memScaleDownThreshold: number;
	cooldownSeconds: number;
};

const DEFAULTS: Form = {
	enabled: false,
	provider: "hetzner",
	token: "",
	sshKeyId: "",
	serverType: "cpx22",
	location: "nbg1",
	image: "ubuntu-24.04",
	networkId: "",
	minNodes: 0,
	maxNodes: 3,
	scaleUpThreshold: 80,
	scaleDownThreshold: 25,
	memScaleUpThreshold: 75,
	memScaleDownThreshold: 25,
	cooldownSeconds: 300,
};

export const ShowAutoscaler = () => {
	const { data: cfg, refetch } = api.nomad.getAutoscalerConfig.useQuery();
	const { data: status, refetch: refetchStatus } =
		api.nomad.getAutoscalerStatus.useQuery(undefined, {
			refetchInterval: 15000,
		});
	const { data: sshKeys } = api.sshKey.all.useQuery();
	const { data: events } = api.nomad.getAutoscalerEvents.useQuery(undefined, {
		refetchInterval: 15000,
	});
	const update = api.nomad.updateAutoscalerConfig.useMutation();
	const reconcile = api.nomad.reconcileAutoscalerNow.useMutation();
	const loadOptions = api.nomad.listProviderOptions.useMutation();

	const [form, setForm] = useState<Form>(DEFAULTS);
	const [hasToken, setHasToken] = useState(false);
	const [options, setOptions] = useState<{
		locations: { name: string; description: string }[];
		networks: { id: string; name: string; zone: string }[];
		serverTypes: { name: string; cores: number; memory: number }[];
	} | null>(null);

	const fetchOptions = async () => {
		try {
			const o = await loadOptions.mutateAsync();
			setOptions(o);
			toast.success("Loaded locations, networks + server types");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to load options");
		}
	};

	useEffect(() => {
		if (cfg) {
			setForm((f) => ({
				...f,
				enabled: cfg.enabled,
				provider: cfg.provider,
				token: "",
				sshKeyId: cfg.sshKeyId ?? "",
				serverType: cfg.serverType,
				location: cfg.location,
				image: cfg.image,
				networkId: cfg.networkId ?? "",
				minNodes: cfg.minNodes,
				maxNodes: cfg.maxNodes,
				scaleUpThreshold: cfg.scaleUpThreshold,
				scaleDownThreshold: cfg.scaleDownThreshold,
				memScaleUpThreshold: cfg.memScaleUpThreshold,
				memScaleDownThreshold: cfg.memScaleDownThreshold,
				cooldownSeconds: cfg.cooldownSeconds,
			}));
			setHasToken(cfg.hasToken);
		}
	}, [cfg]);

	const set = <K extends keyof Form>(k: K, v: Form[K]) =>
		setForm((f) => ({ ...f, [k]: v }));

	const save = async () => {
		try {
			await update.mutateAsync({
				enabled: form.enabled,
				provider: form.provider,
				// Only send the token if the user typed a new one.
				...(form.token ? { token: form.token } : {}),
				sshKeyId: form.sshKeyId || undefined,
				serverType: form.serverType,
				location: form.location,
				image: form.image,
				networkId: form.networkId || undefined,
				minNodes: Number(form.minNodes),
				maxNodes: Number(form.maxNodes),
				scaleUpThreshold: Number(form.scaleUpThreshold),
				scaleDownThreshold: Number(form.scaleDownThreshold),
				memScaleUpThreshold: Number(form.memScaleUpThreshold),
				memScaleDownThreshold: Number(form.memScaleDownThreshold),
				cooldownSeconds: Number(form.cooldownSeconds),
			});
			toast.success("Autoscaler settings saved");
			setForm((f) => ({ ...f, token: "" }));
			refetch();
			refetchStatus();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	const runNow = async () => {
		try {
			await reconcile.mutateAsync();
			toast.success("Reconcile triggered — watch the nodes below");
			setTimeout(() => refetchStatus(), 2000);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed");
		}
	};

	const d = status?.decision;
	const num = (k: keyof Form) => (
		<Input
			type="number"
			value={form[k] as number}
			onChange={(e) => set(k, Number(e.target.value) as never)}
		/>
	);

	return (
		<div className="space-y-4">
			<Card className="bg-sidebar rounded-xl">
				<CardHeader className="flex flex-row items-start justify-between gap-4">
					<div className="space-y-1.5">
						<CardTitle className="flex items-center gap-2 text-xl">
							<Gauge className="h-5 w-5" />
							Cluster autoscaling
						</CardTitle>
						<CardDescription>
							Automatically add worker VMs when the cluster runs out of capacity
							(blocked allocations or high utilization) and remove idle ones —
							within your node limits. New nodes are provisioned on your cloud,
							joined over WireGuard, and drained before removal.
						</CardDescription>
					</div>
					<div className="flex items-center gap-2">
						<Label htmlFor="as-enabled" className="text-sm">
							Enabled
						</Label>
						<Switch
							id="as-enabled"
							checked={form.enabled}
							onCheckedChange={(v) => set("enabled", v === true)}
						/>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label>Provider</Label>
							<Select
								value={form.provider}
								onValueChange={(v) => set("provider", v)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="hetzner">Hetzner Cloud</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label>API token</Label>
							<div className="flex gap-2">
								<Input
									type="password"
									placeholder={
										hasToken
											? "•••••••• (set — leave blank to keep)"
											: "hcloud API token"
									}
									value={form.token}
									onChange={(e) => set("token", e.target.value)}
								/>
								<Button
									type="button"
									variant="secondary"
									onClick={fetchOptions}
									disabled={loadOptions.isPending || (!hasToken && !form.token)}
									title="List locations, networks + server types from the provider (save the token first)"
								>
									{loadOptions.isPending ? "Loading…" : "Load options"}
								</Button>
							</div>
						</div>
						<div className="space-y-2">
							<Label>SSH key (authorized on new nodes)</Label>
							<Select
								value={form.sshKeyId}
								onValueChange={(v) => set("sshKeyId", v)}
							>
								<SelectTrigger>
									<SelectValue placeholder="Select an SSH key" />
								</SelectTrigger>
								<SelectContent>
									{sshKeys?.map((k) => (
										<SelectItem key={k.sshKeyId} value={k.sshKeyId}>
											{k.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<Label>Private network</Label>
							{options ? (
								<Select
									value={form.networkId}
									onValueChange={(v) => set("networkId", v)}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select a network (optional)" />
									</SelectTrigger>
									<SelectContent>
										{options.networks.map((n) => (
											<SelectItem key={n.id} value={n.id}>
												{n.name} ({n.zone}) · {n.id}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<Input
									placeholder="network id (or Load options)"
									value={form.networkId}
									onChange={(e) => set("networkId", e.target.value)}
								/>
							)}
						</div>
						<div className="space-y-2">
							<Label>Location</Label>
							{options ? (
								<Select
									value={form.location}
									onValueChange={(v) => set("location", v)}
								>
									<SelectTrigger>
										<SelectValue placeholder="Select a location" />
									</SelectTrigger>
									<SelectContent>
										{options.locations.map((l) => (
											<SelectItem key={l.name} value={l.name}>
												{l.name} — {l.description}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<Input
									value={form.location}
									onChange={(e) => set("location", e.target.value)}
								/>
							)}
						</div>
						<div className="space-y-2">
							<Label>Image</Label>
							<Input
								value={form.image}
								onChange={(e) => set("image", e.target.value)}
							/>
						</div>
					</div>

					<div className="space-y-2">
						<Label>Server types (tried in order until one is available)</Label>
						<Input
							placeholder="cpx22, cpx32"
							value={form.serverType}
							onChange={(e) => set("serverType", e.target.value)}
						/>
						{options && (
							<div className="flex flex-wrap gap-1">
								{options.serverTypes.map((t) => {
									const list = form.serverType
										.split(",")
										.map((s) => s.trim())
										.filter(Boolean);
									const picked = list.includes(t.name);
									return (
										<button
											type="button"
											key={t.name}
											onClick={() =>
												set(
													"serverType",
													(picked
														? list.filter((x) => x !== t.name)
														: [...list, t.name]
													).join(", "),
												)
											}
										>
											<Badge variant={picked ? "default" : "outline"}>
												{t.name} · {t.cores}c/{t.memory}g
											</Badge>
										</button>
									);
								})}
							</div>
						)}
					</div>

					<div className="grid grid-cols-3 gap-4">
						<div className="space-y-2">
							<Label>Min nodes</Label>
							{num("minNodes")}
						</div>
						<div className="space-y-2">
							<Label>Max nodes</Label>
							{num("maxNodes")}
						</div>
						<div className="space-y-2">
							<Label>Cooldown (s)</Label>
							{num("cooldownSeconds")}
						</div>
					</div>
					<div className="space-y-2">
						<Label>Scaling policies</Label>
						<p className="text-muted-foreground text-xs">
							Based on reservation (requested CPU/mem ÷ cluster capacity, not
							live usage). Each resource is its own policy: the cluster scales
							up if <b>either</b> exceeds its up-threshold, and down only when{" "}
							<b>both</b> are below their down-thresholds.
						</p>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							{(
								[
									{
										title: "CPU reservation",
										up: "scaleUpThreshold",
										down: "scaleDownThreshold",
									},
									{
										title: "Memory reservation",
										up: "memScaleUpThreshold",
										down: "memScaleDownThreshold",
									},
								] as const
							).map((p) => (
								<div key={p.title} className="rounded-lg border p-3 space-y-2">
									<div className="font-medium text-sm">{p.title}</div>
									<div className="flex items-center gap-2 text-sm">
										<span className="w-28 text-muted-foreground">
											scale up above
										</span>
										<div className="w-20">{num(p.up)}</div>
										<span>%</span>
									</div>
									<div className="flex items-center gap-2 text-sm">
										<span className="w-28 text-muted-foreground">
											scale down below
										</span>
										<div className="w-20">{num(p.down)}</div>
										<span>%</span>
									</div>
								</div>
							))}
						</div>
					</div>

					<Button onClick={save} disabled={update.isPending}>
						{update.isPending ? "Saving…" : "Save"}
					</Button>
				</CardContent>
			</Card>

			<Card className="bg-sidebar rounded-xl">
				<CardHeader className="flex flex-row items-center justify-between">
					<CardTitle className="text-lg">Status</CardTitle>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onClick={runNow}
						disabled={reconcile.isPending}
					>
						{reconcile.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<RefreshCw className="mr-2 h-4 w-4" />
						)}
						Reconcile now
					</Button>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex flex-wrap gap-2">
						<Badge variant={status?.enabled ? "default" : "outline"}>
							{status?.enabled ? "enabled" : "disabled"}
						</Badge>
						{d && (
							<>
								<Badge variant="secondary">cpu reserved {d.cpuReserved}%</Badge>
								<Badge variant="secondary">mem reserved {d.memReserved}%</Badge>
								<Badge variant={d.blockedEvals > 0 ? "destructive" : "outline"}>
									{d.blockedEvals} blocked evals
								</Badge>
								<Badge variant="secondary">
									{d.autoscaledCount} autoscaled node
									{d.autoscaledCount === 1 ? "" : "s"}
								</Badge>
								<Badge
									variant={d.action === "none" ? "outline" : "default"}
									title={d.reason}
								>
									next: {d.action}
								</Badge>
							</>
						)}
					</div>

					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Node</TableHead>
									<TableHead>Address</TableHead>
									<TableHead>Overlay IP</TableHead>
									<TableHead>Role</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{status?.nodes && status.nodes.length > 0 ? (
									status.nodes.map((n) => (
										<TableRow key={n.serverId}>
											<TableCell className="font-medium">
												<div className="flex items-center gap-2">
													<Server className="h-4 w-4 text-muted-foreground" />
													{n.name}
												</div>
											</TableCell>
											<TableCell className="font-mono text-xs">
												{n.ipAddress}
											</TableCell>
											<TableCell className="font-mono text-xs">
												{n.wgIp ?? "—"}
											</TableCell>
											<TableCell>
												<Badge variant="secondary">
													{n.clusterRole ?? "joining"}
												</Badge>
											</TableCell>
										</TableRow>
									))
								) : (
									<TableRow>
										<TableCell
											colSpan={4}
											className="text-center text-muted-foreground text-sm"
										>
											No autoscaled nodes.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
				</CardContent>
			</Card>

			<Card className="bg-sidebar rounded-xl">
				<CardHeader>
					<CardTitle className="text-lg">Activity</CardTitle>
					<CardDescription>
						Recent autoscaler actions — scale up/down, provisioning, and errors
						(newest first).
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-[170px]">When</TableHead>
									<TableHead className="w-[110px]">Type</TableHead>
									<TableHead>Message</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{events && events.length > 0 ? (
									events.map((e) => (
										<TableRow key={e.eventId}>
											<TableCell className="text-muted-foreground text-xs">
												{new Date(e.createdAt).toLocaleString()}
											</TableCell>
											<TableCell>
												<Badge
													variant={
														e.type === "error"
															? "destructive"
															: e.type === "scale_up"
																? "default"
																: "secondary"
													}
												>
													{e.type.replace("_", " ")}
												</Badge>
											</TableCell>
											<TableCell className="text-sm">
												{e.message}
												{e.detail && (
													<span className="ml-1 text-muted-foreground text-xs">
														— {e.detail}
													</span>
												)}
											</TableCell>
										</TableRow>
									))
								) : (
									<TableRow>
										<TableCell
											colSpan={3}
											className="text-center text-muted-foreground text-sm"
										>
											No activity yet.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
				</CardContent>
			</Card>
		</div>
	);
};
