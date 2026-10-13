import { Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
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
import { CrowdsecBansChart } from "./crowdsec-bans-chart";

// The WG overlay subnet is always allowlisted server-side (mirror of
// WG_OVERLAY_CIDR in packages/server/src/setup/crowdsec.ts) — shown read-only so
// the operator knows the cluster can never ban itself.
const WG_OVERLAY_CIDR = "10.10.0.0/24";

const IP_OR_CIDR_RE =
	/^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)(?:\/\d{1,3})?$/;

export const Crowdsec = () => {
	const { data, refetch } = api.settings.getCrowdsec.useQuery();
	const {
		data: status,
		refetch: refetchStatus,
		isRefetching: statusRefetching,
	} = api.settings.getCrowdsecStatus.useQuery(undefined, {
		refetchInterval: 15000,
	});
	const { mutateAsync: saveCrowdsec, isPending } =
		api.settings.saveCrowdsec.useMutation();
	const { mutateAsync: unban } = api.settings.crowdsecUnban.useMutation();

	const [enabled, setEnabled] = useState(false);
	const [enforce, setEnforce] = useState(false);
	const [allowlist, setAllowlist] = useState<string[]>([]);
	const [newEntry, setNewEntry] = useState("");

	// Prefill form state ONCE from the query (a re-sync on every refetch would
	// clobber in-flight edits and un-stick the toggle — same bug fixed in the
	// Observability tab).
	const prefilled = useRef(false);
	useEffect(() => {
		if (!data || prefilled.current) return;
		setEnabled(data.enabled);
		setEnforce(data.enforce);
		setAllowlist(data.allowlist ?? []);
		prefilled.current = true;
	}, [data]);

	const addEntry = () => {
		const v = newEntry.trim();
		if (v === "") return;
		if (!IP_OR_CIDR_RE.test(v)) {
			toast.error("Enter a valid IP or CIDR (e.g. 1.2.3.4 or 1.2.3.0/24)");
			return;
		}
		if (allowlist.includes(v)) {
			setNewEntry("");
			return;
		}
		setAllowlist([...allowlist, v]);
		setNewEntry("");
	};

	const save = async () => {
		try {
			await saveCrowdsec({
				enabled,
				// Only enforce when enabled; blocking applies on the load balancer.
				enforce: enabled && enforce,
				allowlist,
			});
			toast.success("CrowdSec settings saved");
			await refetch();
			await refetchStatus();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save");
		}
	};

	const handleUnban = async (ip: string) => {
		try {
			await unban({ ip });
			toast.success(`Unbanned ${ip}`);
			await refetchStatus();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to unban");
		}
	};

	const decisions = status?.decisions ?? null;

	return (
		<Card className="bg-transparent">
			<CardHeader>
				<div className="flex flex-row items-center justify-between gap-2">
					<div>
						<CardTitle className="text-xl">CrowdSec</CardTitle>
						<CardDescription>
							Detect malicious traffic from the hub Traefik access log. Runs on
							the hub as a single detector and lists the bans it would apply.
						</CardDescription>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => refetchStatus()}
						disabled={statusRefetching}
					>
						<RefreshCw
							className={`size-4 ${statusRefetching ? "animate-spin" : ""}`}
						/>
					</Button>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				{enforce ? (
					<AlertBlock type="warning">
						Enforcing: the CrowdSec bouncer <b>blocks banned IPs on the load
						balancer</b> (app traffic, stream mode). Make sure your admin IP is
						in the allowlist below — the WireGuard subnet{" "}
						<code>{WG_OVERLAY_CIDR}</code> and the allowlist always bypass the
						bouncer, so the cluster can never lock itself out.
					</AlertBlock>
				) : (
					<AlertBlock type="info">
						Detection-only: CrowdSec collects decisions (bans) but <b>nothing is
						blocked</b>. Turn on <b>Enforce</b> to block banned IPs on the load
						balancer. The WireGuard subnet <code>{WG_OVERLAY_CIDR}</code> and the
						allowlist always bypass the bouncer.
					</AlertBlock>
				)}

				{/* Enable + status */}
				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex flex-col gap-1">
						<Label className="text-base">Enable CrowdSec</Label>
						<span className="text-sm text-muted-foreground">
							Deploy the detector on the hub (reads the Traefik access log).
						</span>
					</div>
					<Switch checked={enabled} onCheckedChange={setEnabled} />
				</div>

				{status && (
					<div className="flex flex-wrap items-center gap-2 text-sm">
						<Badge variant={status.deployed ? "default" : "secondary"}>
							{status.deployed ? "Deployed" : "Not deployed"}
						</Badge>
						<Badge variant={status.runningAllocs > 0 ? "default" : "secondary"}>
							{status.runningAllocs > 0 ? "Running" : "Stopped"}
						</Badge>
						{status.node && (
							<span className="text-muted-foreground">node: {status.node}</span>
						)}
						<span className="text-muted-foreground">image: {status.image}</span>
					</div>
				)}

				{/* Enforce */}
				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="flex flex-col gap-1">
						<Label className="text-base">Enforce (block on the load balancer)</Label>
						<span className="text-sm text-muted-foreground">
							Apply the CrowdSec bouncer globally on the HA pool (app traffic),
							stream mode. Off = detection-only.
						</span>
					</div>
					<Switch
						checked={enforce}
						onCheckedChange={setEnforce}
						disabled={!enabled}
					/>
				</div>

				{/* Allowlist */}
				<div className="flex flex-col gap-2">
					<Label>Allowlist (never banned)</Label>
					<p className="text-sm text-muted-foreground">
						Add your admin IP here so you're never locked out. CIDRs allowed.
					</p>
					<div className="flex flex-row gap-2">
						<Input
							placeholder="1.2.3.4 or 1.2.3.0/24"
							value={newEntry}
							onChange={(e) => setNewEntry(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									addEntry();
								}
							}}
						/>
						<Button type="button" variant="secondary" onClick={addEntry}>
							<Plus className="size-4" />
						</Button>
					</div>
					<div className="flex flex-wrap gap-2 pt-1">
						<Badge variant="outline" className="gap-1">
							{WG_OVERLAY_CIDR}
							<span className="text-muted-foreground">(auto)</span>
						</Badge>
						{allowlist.map((entry) => (
							<Badge key={entry} variant="secondary" className="gap-1">
								{entry}
								<button
									type="button"
									onClick={() =>
										setAllowlist(allowlist.filter((e) => e !== entry))
									}
									className="ml-1 text-muted-foreground hover:text-foreground"
								>
									<Trash2 className="size-3" />
								</button>
							</Badge>
						))}
					</div>
				</div>

				<div>
					<Button onClick={save} isLoading={isPending}>
						Save
					</Button>
				</div>

				{/* Bans over time */}
				{data?.enabled && <CrowdsecBansChart />}

				{/* Decisions */}
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<ShieldAlert className="size-4 text-muted-foreground" />
						<Label className="text-base">Decisions (would-be bans)</Label>
					</div>
					{decisions === null ? (
						<p className="text-sm text-muted-foreground">
							{status?.runningAllocs
								? "Couldn't read decisions from the running detector."
								: "Detector not running — enable CrowdSec and save."}
						</p>
					) : decisions.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No active decisions. 🎉
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>IP / range</TableHead>
									<TableHead>Scenario</TableHead>
									<TableHead>Action</TableHead>
									<TableHead>Origin</TableHead>
									<TableHead>Duration</TableHead>
									<TableHead className="text-right">Unban</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{decisions.map((d, i) => (
									<TableRow key={`${d.value}-${d.id ?? i}`}>
										<TableCell className="font-mono text-xs">
											{d.value}
										</TableCell>
										<TableCell className="text-xs">{d.scenario}</TableCell>
										<TableCell>
											<Badge variant="outline">{d.type}</Badge>
										</TableCell>
										<TableCell className="text-xs text-muted-foreground">
											{d.origin}
										</TableCell>
										<TableCell className="text-xs">{d.duration}</TableCell>
										<TableCell className="text-right">
											<DialogAction
												title={`Unban ${d.value}?`}
												description="Remove all CrowdSec decisions for this IP/range."
												onClick={() => handleUnban(d.value)}
											>
												<Button variant="ghost" size="sm">
													<Trash2 className="size-4" />
												</Button>
											</DialogAction>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</div>
			</CardContent>
		</Card>
	);
};
