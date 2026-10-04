import { Copy, KeyRound, Loader2, PlusIcon, Trash2 } from "lucide-react";
import { useState } from "react";
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
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
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

const SCOPES = [
	{
		value: "read",
		label: "Read-only (collect / monitor)",
		help: "List jobs, allocations and nodes. Low risk — good for monitoring/collectors.",
	},
	{
		value: "deploy",
		label: "Read + deploy (submit jobs)",
		help: "Also submit/manage Nomad jobs. Powerful — near-admin for the namespace.",
	},
] as const;

const CreateTokenDialog = ({ onDone }: { onDone: () => void }) => {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [scope, setScope] = useState<"read" | "deploy">("read");
	const [secret, setSecret] = useState<string | null>(null);
	const create = api.nomadToken.create.useMutation();

	const submit = async () => {
		try {
			const res = await create.mutateAsync({ name: name.trim(), scope });
			setSecret(res.secretId);
			onDone();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to create token");
		}
	};

	const close = () => {
		setOpen(false);
		setName("");
		setScope("read");
		setSecret(null);
	};

	const spec = SCOPES.find((s) => s.value === scope);

	return (
		<Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
			<DialogTrigger asChild>
				<Button size="sm">
					<PlusIcon className="mr-2 size-4" />
					New token
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create Nomad token</DialogTitle>
					<DialogDescription>
						Minted via the control plane's management token and scoped to a
						preset policy. Set it as a service's Nomad token so it can call the
						Nomad API.
					</DialogDescription>
				</DialogHeader>

				{secret ? (
					<div className="flex flex-col gap-3">
						<AlertBlock type="warning">
							Copy this token now — it is shown only once and is not stored.
						</AlertBlock>
						<div className="flex items-center gap-2">
							<Input readOnly value={secret} className="font-mono text-xs" />
							<Button
								variant="outline"
								size="icon"
								onClick={() => {
									navigator.clipboard.writeText(secret).then(
										() => toast.success("Token copied"),
										() => toast.error("Copy failed"),
									);
								}}
							>
								<Copy className="size-4" />
							</Button>
						</div>
						<DialogFooter>
							<Button onClick={close}>Done</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="token-name">Name</Label>
							<Input
								id="token-name"
								placeholder="goliash-collector"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Scope</Label>
							<Select
								value={scope}
								onValueChange={(v) => setScope(v as "read" | "deploy")}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SCOPES.map((s) => (
										<SelectItem key={s.value} value={s.value}>
											{s.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">{spec?.help}</p>
						</div>
						<DialogFooter>
							<Button
								onClick={submit}
								disabled={!name.trim()}
								isLoading={create.isPending}
							>
								Create
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
};

export const ShowNomadTokens = () => {
	const { data, isPending, refetch, isError, error } =
		api.nomadToken.list.useQuery();
	const del = api.nomadToken.delete.useMutation();
	const tokens = data ?? [];

	return (
		<div className="w-full">
			<Card className="mx-auto h-full max-w-5xl rounded-xl bg-sidebar p-2.5">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row items-start justify-between gap-4">
						<div>
							<CardTitle className="flex flex-row gap-2 text-xl">
								<KeyRound className="size-6 self-center text-orange-500" />
								Nomad API Tokens
							</CardTitle>
							<CardDescription>
								Scoped Nomad ACL tokens for services that call the Nomad API
								(e.g. a collector or deploy tool). Minted via the control
								plane's management token; the secret is shown once and not
								stored.
							</CardDescription>
						</div>
						<CreateTokenDialog onDone={refetch} />
					</CardHeader>
					<CardContent className="space-y-2 border-t py-8">
						{isError ? (
							<AlertBlock type="error">
								{error?.message ?? "Failed to list tokens"} — Nomad ACLs must be
								enabled.
							</AlertBlock>
						) : isPending ? (
							<div className="flex min-h-[25vh] items-center justify-center gap-2 text-muted-foreground text-sm">
								<span>Loading...</span>
								<Loader2 className="size-4 animate-spin" />
							</div>
						) : tokens.length === 0 ? (
							<div className="flex min-h-[25vh] flex-col items-center justify-center gap-3">
								<KeyRound className="size-8 text-muted-foreground" />
								<span className="text-base text-muted-foreground">
									No Nomad tokens yet.
								</span>
							</div>
						) : (
							<div className="flex flex-col gap-3">
								{tokens.map((t) => (
									<div
										key={t.accessorId}
										className="flex items-center justify-between rounded-lg border bg-background p-3.5"
									>
										<div className="flex flex-col gap-0.5">
											<span className="flex items-center gap-2 font-medium text-sm">
												{t.name}
												<Badge variant="secondary" className="font-normal">
													{t.scope}
												</Badge>
											</span>
											<span className="text-muted-foreground text-xs">
												accessor {t.accessorId.slice(0, 8)}…
												{t.createTime
													? ` · ${new Date(t.createTime).toLocaleString()}`
													: ""}
											</span>
										</div>
										<DialogAction
											title="Revoke token"
											description="Revoke this Nomad token? Any service using it will immediately lose Nomad API access."
											type="destructive"
											onClick={async () => {
												await del
													.mutateAsync({ accessorId: t.accessorId })
													.then(() => {
														toast.success("Token revoked");
														refetch();
													})
													.catch((e) => toast.error(e.message));
											}}
										>
											<Button
												variant="ghost"
												size="icon"
												className="group hover:bg-red-500/10"
											>
												<Trash2 className="size-3.5 text-primary group-hover:text-red-500" />
											</Button>
										</DialogAction>
									</div>
								))}
							</div>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
