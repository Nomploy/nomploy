import { Box, Copy, Loader2, Power, Save } from "lucide-react";
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
import { api } from "@/utils/api";

// Matches the ZOT_DONE / OP_ENDED sentinels streamed by the nomad router.
const ZOT_DONE = "ZOT_DONE";
const OP_ENDED = "OP_ENDED";

type Form = {
	storageKind: "local" | "s3";
	port: number;
	username: string;
	password: string;
	s3Bucket: string;
	s3Region: string;
	s3Endpoint: string;
	s3AccessKeyId: string;
	s3SecretAccessKey: string;
};

const DEFAULTS: Form = {
	storageKind: "local",
	port: 5000,
	username: "nomploy",
	password: "",
	s3Bucket: "",
	s3Region: "",
	s3Endpoint: "",
	s3AccessKeyId: "",
	s3SecretAccessKey: "",
};

export const ShowZotRegistry = () => {
	const { data: cfg, refetch } = api.nomad.getZotRegistry.useQuery();
	const update = api.nomad.updateZotRegistry.useMutation();
	const disable = api.nomad.disableZotRegistry.useMutation();

	const [form, setForm] = useState<Form>(DEFAULTS);
	const [isEnabling, setIsEnabling] = useState(false);
	const [logs, setLogs] = useState("");

	// Hydrate the form from saved config (secrets stay blank — placeholders show
	// "set"; leaving them blank keeps the stored value on save).
	useEffect(() => {
		if (!cfg) return;
		setForm((f) => ({
			...f,
			storageKind: (cfg.storageKind as "local" | "s3") ?? "local",
			port: cfg.port ?? 5000,
			username: cfg.username ?? "nomploy",
			s3Bucket: cfg.s3Bucket ?? "",
			s3Region: cfg.s3Region ?? "",
			s3Endpoint: cfg.s3Endpoint ?? "",
			s3AccessKeyId: cfg.s3AccessKeyId ?? "",
		}));
	}, [cfg]);

	const set = <K extends keyof Form>(k: K, v: Form[K]) =>
		setForm((f) => ({ ...f, [k]: v }));

	const save = async () => {
		try {
			await update.mutateAsync({
				storageKind: form.storageKind,
				port: form.port,
				username: form.username,
				// Only send secrets when typed (blank keeps the stored value).
				...(form.password ? { password: form.password } : {}),
				s3Bucket: form.s3Bucket,
				s3Region: form.s3Region,
				s3Endpoint: form.s3Endpoint,
				s3AccessKeyId: form.s3AccessKeyId,
				...(form.s3SecretAccessKey
					? { s3SecretAccessKey: form.s3SecretAccessKey }
					: {}),
			});
			toast.success("Registry settings saved");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	api.nomad.enableZotRegistry.useSubscription(undefined, {
		enabled: isEnabling,
		onData(log) {
			if (log === ZOT_DONE) {
				setIsEnabling(false);
				toast.success("Registry is up");
				refetch();
				return;
			}
			if (log.includes(OP_ENDED)) {
				setIsEnabling(false);
				return;
			}
			setLogs((prev) => prev + log);
		},
		onError(err) {
			setIsEnabling(false);
			toast.error(err.message || "Enable failed");
		},
	});

	const startEnable = async () => {
		// Persist current settings first, then deploy.
		await save();
		setLogs("");
		setIsEnabling(true);
	};

	const handleDisable = async () => {
		try {
			await disable.mutateAsync();
			toast.success("Registry disabled");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to disable");
		}
	};

	const enabled = !!cfg?.enabled;
	const address = cfg?.address ?? `10.10.0.1:${form.port}`;

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1.5">
					<CardTitle className="flex items-center gap-2 text-xl">
						<Box className="size-5" />
						Built-in registry (zot)
					</CardTitle>
					<CardDescription>
						A self-hosted OCI registry on the control plane so nomploy can build
						→ push → pull with no external registry. Stores images on the local
						disk or an S3-compatible bucket.
					</CardDescription>
				</div>
				<Badge variant={enabled ? "default" : "outline"}>
					{enabled ? "enabled" : "disabled"}
				</Badge>
			</CardHeader>

			<CardContent className="flex flex-col gap-5">
				{enabled && (
					<div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
						<span className="font-medium">Registry:</span>
						<code className="rounded bg-background px-1.5 py-0.5">
							{address}
						</code>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => {
								navigator.clipboard?.writeText(address);
								toast.success("Address copied");
							}}
						>
							<Copy className="mr-1 h-3.5 w-3.5" /> copy
						</Button>
						<span className="text-muted-foreground text-xs">
							push: <code>docker push {address}/nomploy/&lt;image&gt;</code>
						</span>
					</div>
				)}

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label>Storage</Label>
						<Select
							value={form.storageKind}
							onValueChange={(v) => set("storageKind", v as "local" | "s3")}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="local">Local filesystem</SelectItem>
								<SelectItem value="s3">S3-compatible</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<Label>Port</Label>
						<Input
							type="number"
							value={form.port}
							onChange={(e) => set("port", Number(e.target.value) || 5000)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label>Username</Label>
						<Input
							value={form.username}
							onChange={(e) => set("username", e.target.value)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label>Password</Label>
						<Input
							type="password"
							placeholder={cfg?.hasPassword ? "•••••• (set)" : "set a password"}
							value={form.password}
							onChange={(e) => set("password", e.target.value)}
						/>
					</div>
				</div>

				{form.storageKind === "s3" && (
					<div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label>Bucket</Label>
							<Input
								value={form.s3Bucket}
								onChange={(e) => set("s3Bucket", e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label>Region</Label>
							<Input
								value={form.s3Region}
								onChange={(e) => set("s3Region", e.target.value)}
							/>
						</div>
						<div className="space-y-1.5 sm:col-span-2">
							<Label>Endpoint (S3-compatible; blank for AWS)</Label>
							<Input
								placeholder="e.g. minio.example.com or s3.eu-central-1.amazonaws.com"
								value={form.s3Endpoint}
								onChange={(e) => set("s3Endpoint", e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label>Access key ID</Label>
							<Input
								value={form.s3AccessKeyId}
								onChange={(e) => set("s3AccessKeyId", e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label>Secret access key</Label>
							<Input
								type="password"
								placeholder={cfg?.hasS3Secret ? "•••••• (set)" : ""}
								value={form.s3SecretAccessKey}
								onChange={(e) => set("s3SecretAccessKey", e.target.value)}
							/>
						</div>
					</div>
				)}

				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						variant="secondary"
						onClick={save}
						disabled={update.isPending || isEnabling}
					>
						<Save className="mr-2 h-4 w-4" /> Save settings
					</Button>
					<Button type="button" onClick={startEnable} disabled={isEnabling}>
						{isEnabling ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Power className="mr-2 h-4 w-4" />
						)}
						{isEnabling ? "Deploying…" : enabled ? "Reconfigure" : "Enable"}
					</Button>
					{enabled && (
						<Button
							type="button"
							variant="destructive"
							onClick={handleDisable}
							disabled={disable.isPending || isEnabling}
						>
							Disable
						</Button>
					)}
				</div>

				{(isEnabling || logs) && (
					<pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-lg bg-black p-4 font-mono text-green-400 text-xs">
						{logs || "Deploying registry…"}
					</pre>
				)}
			</CardContent>
		</Card>
	);
};
