import { Gauge, Loader2, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
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
	name: string;
	poolName: string;
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
	name: "",
	poolName: "",
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

type GroupRow = NonNullable<
	ReturnType<typeof api.nomad.listAutoscalingGroups.useQuery>["data"]
>[number];
type StatusEntry = NonNullable<
	ReturnType<typeof api.nomad.getAutoscalerStatus.useQuery>["data"]
>[number];

// One autoscaling group (Nomad node pool) — its own launch template + policy.
const GroupCard = ({
	group,
	status,
	sshKeys,
	onChanged,
	onCancelNew,
}: {
	group?: GroupRow;
	status?: StatusEntry;
	sshKeys?: { sshKeyId: string; name: string }[];
	onChanged: () => void;
	onCancelNew?: () => void;
}) => {
	const isDefault = group?.isDefault ?? false;
	const upsert = api.nomad.upsertAutoscalingGroup.useMutation();
	const remove = api.nomad.deleteAutoscalingGroup.useMutation();
	const loadOptions = api.nomad.listProviderOptions.useMutation();

	const [form, setForm] = useState<Form>({
		...DEFAULTS,
		...(group
			? {
					name: group.name,
					poolName: group.poolName,
					enabled: group.enabled,
					provider: group.provider,
					sshKeyId: group.sshKeyId ?? "",
					serverType: group.serverType,
					location: group.location,
					image: group.image,
					networkId: group.networkId ?? "",
					minNodes: group.minNodes,
					maxNodes: group.maxNodes,
					scaleUpThreshold: group.scaleUpThreshold,
					scaleDownThreshold: group.scaleDownThreshold,
					memScaleUpThreshold: group.memScaleUpThreshold,
					memScaleDownThreshold: group.memScaleDownThreshold,
					cooldownSeconds: group.cooldownSeconds,
				}
			: {}),
	});
	const [hasToken, setHasToken] = useState(group?.hasToken ?? false);
	const [options, setOptions] = useState<{
		locations: { name: string; description: string }[];
		networks: { id: string; name: string; zone: string }[];
		serverTypes: { name: string; cores: number; memory: number }[];
	} | null>(null);

	// Reset the form when the underlying group changes (after a refetch).
	useEffect(() => {
		if (group) {
			setForm({
				...DEFAULTS,
				name: group.name,
				poolName: group.poolName,
				enabled: group.enabled,
				provider: group.provider,
				sshKeyId: group.sshKeyId ?? "",
				serverType: group.serverType,
				location: group.location,
				image: group.image,
				networkId: group.networkId ?? "",
				minNodes: group.minNodes,
				maxNodes: group.maxNodes,
				scaleUpThreshold: group.scaleUpThreshold,
				scaleDownThreshold: group.scaleDownThreshold,
				memScaleUpThreshold: group.memScaleUpThreshold,
				memScaleDownThreshold: group.memScaleDownThreshold,
				cooldownSeconds: group.cooldownSeconds,
			});
			setHasToken(group.hasToken);
		}
	}, [group?.groupId]);

	const set = <K extends keyof Form>(k: K, v: Form[K]) =>
		setForm((f) => ({ ...f, [k]: v }));

	const fetchOptions = async () => {
		try {
			const o = await loadOptions.mutateAsync({
				groupId: group?.groupId,
				token: form.token || undefined,
				provider: form.provider,
				location: form.location,
				image: form.image,
			});
			setOptions(o);
			toast.success("Loaded locations, networks + server types");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to load options");
		}
	};

	const save = async () => {
		if (!form.name.trim() || !form.poolName.trim()) {
			toast.error("Group needs a name and a pool name");
			return;
		}
		if (Number(form.maxNodes) < Number(form.minNodes)) {
			toast.error("Max nodes must be ≥ min nodes");
			return;
		}
		try {
			await upsert.mutateAsync({
				groupId: group?.groupId,
				name: form.name.trim(),
				poolName: form.poolName.trim(),
				enabled: form.enabled,
				provider: form.provider,
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
			toast.success("Group saved");
			setForm((f) => ({ ...f, token: "" }));
			onCancelNew?.();
			onChanged();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	const del = async () => {
		if (!group) return onCancelNew?.();
		try {
			await remove.mutateAsync({ groupId: group.groupId });
			toast.success(`Group "${group.name}" deleted`);
			onChanged();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to delete");
		}
	};

	const num = (k: keyof Form, opts?: { min?: number; max?: number }) => (
		<Input
			type="number"
			min={opts?.min}
			max={opts?.max}
			value={form[k] as number}
			onChange={(e) => set(k, Number(e.target.value) as never)}
		/>
	);

	const d = status?.decision;

	return (
		<Card className="bg-sidebar rounded-xl">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1.5">
					<CardTitle className="flex items-center gap-2 text-lg">
						<Gauge className="h-5 w-5" />
						{group ? group.name : "New group"}
						{isDefault && <Badge variant="outline">default</Badge>}
						{group && (
							<Badge variant="secondary" className="font-mono">
								pool: {group.poolName}
							</Badge>
						)}
					</CardTitle>
					<CardDescription>
						An autoscaling group is a Nomad node pool with its own launch
						template + scaling policy. Target it from a job's node pool to drive
						its scaling.
					</CardDescription>
				</div>
				<div className="flex items-center gap-2">
					<Label className="text-sm">Enabled</Label>
					<Switch
						checked={form.enabled}
						onCheckedChange={(v) => set("enabled", v === true)}
					/>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label>Group name</Label>
						<Input
							placeholder="memory, gpu, burst…"
							value={form.name}
							disabled={isDefault}
							onChange={(e) => set("name", e.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label>Node pool</Label>
						<Input
							placeholder="memory"
							value={form.poolName}
							disabled={isDefault || !!group}
							onChange={(e) => set("poolName", e.target.value)}
						/>
					</div>
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
								title="List locations, networks + server types from the provider"
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
						<Label>Min worker nodes</Label>
						{num("minNodes", { min: 0 })}
					</div>
					<div className="space-y-2">
						<Label>Max worker nodes</Label>
						{num("maxNodes", { min: 0 })}
					</div>
					<div className="space-y-2">
						<Label>Cooldown (s)</Label>
						{num("cooldownSeconds", { min: 0 })}
					</div>
				</div>
				<p className="text-xs text-muted-foreground">
					Min/Max bound the <strong>total</strong> workers in this pool — both
					autoscaler-provisioned and manually added. Manually-added nodes are
					pinned: they count toward the minimum but the autoscaler never removes
					them; it only adds/removes its own nodes to keep the total in range.
				</p>

				<div className="space-y-2">
					<Label>Scaling policies</Label>
					<p className="text-muted-foreground text-xs">
						Based on reservation within this pool (requested CPU/mem ÷ pool
						capacity). Scales up if <b>either</b> exceeds its up-threshold, down
						only when <b>both</b> are below their down-thresholds.
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
									<div className="w-20">{num(p.up, { min: 0, max: 100 })}</div>
									<span>%</span>
								</div>
								<div className="flex items-center gap-2 text-sm">
									<span className="w-28 text-muted-foreground">
										scale down below
									</span>
									<div className="w-20">
										{num(p.down, { min: 0, max: 100 })}
									</div>
									<span>%</span>
								</div>
							</div>
						))}
					</div>
				</div>

				{/* Live status for this group */}
				{d && (
					<div className="flex flex-wrap gap-2">
						<Badge variant="secondary">cpu {d.cpuReserved}%</Badge>
						<Badge variant="secondary">mem {d.memReserved}%</Badge>
						<Badge variant={d.blockedEvals > 0 ? "destructive" : "outline"}>
							{d.blockedEvals} blocked
						</Badge>
						<Badge variant="secondary">
							{d.workerCount} node{d.workerCount === 1 ? "" : "s"}
						</Badge>
						<Badge
							variant={d.action === "none" ? "outline" : "default"}
							title={d.reason}
						>
							next: {d.action}
						</Badge>
					</div>
				)}
				{status?.nodes && status.nodes.length > 0 && (
					<div className="overflow-x-auto rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Node</TableHead>
									<TableHead>Overlay IP</TableHead>
									<TableHead>Managed</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{status.nodes.map((n) => (
									<TableRow key={n.serverId}>
										<TableCell className="font-medium">
											<div className="flex items-center gap-2">
												<Server className="h-4 w-4 text-muted-foreground" />
												{n.name}
											</div>
										</TableCell>
										<TableCell className="font-mono text-xs">
											{n.wgIp ?? "—"}
										</TableCell>
										<TableCell>
											<Badge variant={n.autoscaled ? "default" : "outline"}>
												{n.autoscaled ? "autoscaled" : "pinned"}
											</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}

				<div className="flex items-center gap-2">
					<Button onClick={save} disabled={upsert.isPending}>
						{upsert.isPending ? "Saving…" : "Save"}
					</Button>
					{!isDefault && (
						<Button
							variant="ghost"
							size="sm"
							onClick={del}
							disabled={remove.isPending}
							className="text-destructive hover:text-destructive"
						>
							<Trash2 className="mr-1 h-4 w-4" />
							{group ? "Delete group" : "Cancel"}
						</Button>
					)}
				</div>
			</CardContent>
		</Card>
	);
};

export const ShowAutoscaler = () => {
	const { data: groups, refetch } = api.nomad.listAutoscalingGroups.useQuery();
	const { data: status, refetch: refetchStatus } =
		api.nomad.getAutoscalerStatus.useQuery(undefined, {
			refetchInterval: 15000,
		});
	const { data: sshKeys } = api.sshKey.all.useQuery();
	const { data: events } = api.nomad.getAutoscalerEvents.useQuery(undefined, {
		refetchInterval: 15000,
	});
	const reconcile = api.nomad.reconcileAutoscalerNow.useMutation();
	const [newCards, setNewCards] = useState(0);

	const statusFor = (groupId: string) =>
		status?.find((s) => s.groupId === groupId);

	const runNow = async () => {
		try {
			await reconcile.mutateAsync();
			toast.success("Reconcile triggered for all groups");
			setTimeout(() => refetchStatus(), 2000);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed");
		}
	};

	const onChanged = () => {
		refetch();
		refetchStatus();
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-xl font-semibold">Autoscaling groups</h2>
					<p className="text-sm text-muted-foreground">
						Each group is a Nomad node pool with its own template + scaling
						policy. Add groups for differently-sized or regional worker pools.
					</p>
				</div>
				<div className="flex items-center gap-2">
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
					<Button
						type="button"
						size="sm"
						onClick={() => setNewCards((n) => n + 1)}
					>
						<Plus className="mr-1 h-4 w-4" />
						Add group
					</Button>
				</div>
			</div>

			{groups?.map((g) => (
				<GroupCard
					key={g.groupId}
					group={g}
					status={statusFor(g.groupId)}
					sshKeys={sshKeys}
					onChanged={onChanged}
				/>
			))}

			{Array.from({ length: newCards }).map((_, i) => (
				<GroupCard
					key={`new-${i}`}
					sshKeys={sshKeys}
					onChanged={onChanged}
					onCancelNew={() => setNewCards((n) => Math.max(0, n - 1))}
				/>
			))}

			<Card className="bg-sidebar rounded-xl">
				<CardHeader>
					<CardTitle className="text-lg">Activity</CardTitle>
					<CardDescription>
						Recent autoscaler actions across all groups — scale up/down,
						provisioning, and errors (newest first).
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
