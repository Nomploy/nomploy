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
	cooldownSeconds: number;
};

const DEFAULTS: Form = {
	enabled: false,
	provider: "hetzner",
	token: "",
	sshKeyId: "",
	serverType: "cx22",
	location: "nbg1",
	image: "ubuntu-24.04",
	networkId: "",
	minNodes: 0,
	maxNodes: 3,
	scaleUpThreshold: 80,
	scaleDownThreshold: 25,
	cooldownSeconds: 300,
};

export const ShowAutoscaler = () => {
	const { data: cfg, refetch } = api.nomad.getAutoscalerConfig.useQuery();
	const { data: status, refetch: refetchStatus } =
		api.nomad.getAutoscalerStatus.useQuery(undefined, {
			refetchInterval: 15000,
		});
	const { data: sshKeys } = api.sshKey.all.useQuery();
	const update = api.nomad.updateAutoscalerConfig.useMutation();
	const reconcile = api.nomad.reconcileAutoscalerNow.useMutation();

	const [form, setForm] = useState<Form>(DEFAULTS);
	const [hasToken, setHasToken] = useState(false);

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
							<Label>Private network id (optional)</Label>
							<Input
								placeholder="hcloud network id"
								value={form.networkId}
								onChange={(e) => set("networkId", e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Server type</Label>
							<Input
								value={form.serverType}
								onChange={(e) => set("serverType", e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Location</Label>
							<Input
								value={form.location}
								onChange={(e) => set("location", e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Image</Label>
							<Input
								value={form.image}
								onChange={(e) => set("image", e.target.value)}
							/>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
						<div className="space-y-2">
							<Label>Min nodes</Label>
							{num("minNodes")}
						</div>
						<div className="space-y-2">
							<Label>Max nodes</Label>
							{num("maxNodes")}
						</div>
						<div className="space-y-2">
							<Label>Scale-up %</Label>
							{num("scaleUpThreshold")}
						</div>
						<div className="space-y-2">
							<Label>Scale-down %</Label>
							{num("scaleDownThreshold")}
						</div>
						<div className="space-y-2">
							<Label>Cooldown (s)</Label>
							{num("cooldownSeconds")}
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
								<Badge variant="secondary">utilization {d.utilization}%</Badge>
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
		</div>
	);
};
