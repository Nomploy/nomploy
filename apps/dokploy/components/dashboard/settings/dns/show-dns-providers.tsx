import { Globe, Loader2, PlusIcon, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { api } from "@/utils/api";

// Create/edit dialog. On edit the token is left blank (masked) and only
// overwritten when a new one is typed.
const HandleDnsProvider = ({
	dnsProviderId,
	name: initialName,
	onDone,
}: {
	dnsProviderId?: string;
	name?: string;
	onDone: () => void;
}) => {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(initialName ?? "");
	const [token, setToken] = useState("");
	const create = api.dnsProvider.create.useMutation();
	const update = api.dnsProvider.update.useMutation();
	const test = api.dnsProvider.testConnection.useMutation();
	const isEdit = !!dnsProviderId;

	const onTest = async () => {
		try {
			const res = await test.mutateAsync({
				provider: "cloudflare",
				token: token || undefined,
				dnsProviderId,
			});
			toast.success(res.detail);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Test failed");
		}
	};

	const onSave = async () => {
		try {
			if (isEdit) {
				await update.mutateAsync({
					dnsProviderId,
					name: name.trim(),
					provider: "cloudflare",
					token: token || undefined,
				});
			} else {
				await create.mutateAsync({
					name: name.trim(),
					provider: "cloudflare",
					token,
				});
			}
			toast.success(isEdit ? "DNS provider updated" : "DNS provider added");
			setOpen(false);
			setToken("");
			onDone();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Error saving");
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{isEdit ? (
					<Button variant="ghost" size="sm">
						Edit
					</Button>
				) : (
					<Button>
						<PlusIcon className="mr-2 size-4" />
						Add DNS provider
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{isEdit ? "Edit DNS provider" : "Add DNS provider"}
					</DialogTitle>
					<DialogDescription>
						A Cloudflare API token (Zone · DNS · Edit) used for ACME DNS-01
						certificate issuance.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="dns-name">Name</Label>
						<Input
							id="dns-name"
							placeholder="Cloudflare (spertulo.sk)"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Provider</Label>
						<Badge variant="secondary" className="w-fit">
							Cloudflare
						</Badge>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="dns-token">
							API token{isEdit ? " (leave blank to keep current)" : ""}
						</Label>
						<Input
							id="dns-token"
							type="password"
							placeholder="cloudflare API token"
							value={token}
							onChange={(e) => setToken(e.target.value)}
						/>
					</div>
				</div>
				<DialogFooter className="gap-2">
					<Button
						variant="outline"
						onClick={onTest}
						isLoading={test.isPending}
						disabled={!token && !isEdit}
					>
						Test
					</Button>
					<Button
						onClick={onSave}
						isLoading={create.isPending || update.isPending}
						disabled={!name.trim() || (!isEdit && !token)}
					>
						{isEdit ? "Save" : "Add"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const ShowDnsProviders = () => {
	const { data, isPending, refetch } = api.dnsProvider.all.useQuery();
	const { mutateAsync: remove, isPending: isRemoving } =
		api.dnsProvider.remove.useMutation();
	const { mutateAsync: activate } = api.dnsProvider.activate.useMutation();
	const { mutateAsync: deactivate } = api.dnsProvider.deactivate.useMutation();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canManage = !!permissions?.server?.create;

	return (
		<div className="w-full">
			<Card className="mx-auto h-full max-w-5xl rounded-xl bg-sidebar p-2.5">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="flex flex-row gap-2 text-xl">
							<Globe className="size-6 self-center text-orange-500" />
							DNS Providers
						</CardTitle>
						<CardDescription>
							Register a DNS provider (Cloudflare) for ACME DNS-01 certificate
							issuance — the prerequisite for HA "LoadBalancer" ingress (any
							Traefik can obtain certs without the HTTP-01 challenge hitting
							that instance).
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-2 border-t py-8">
						{isPending ? (
							<div className="flex min-h-[25vh] flex-row items-center justify-center gap-2 text-muted-foreground text-sm">
								<span>Loading...</span>
								<Loader2 className="size-4 animate-spin" />
							</div>
						) : data?.length === 0 ? (
							<div className="flex min-h-[25vh] flex-col items-center justify-center gap-3">
								<Globe className="size-8 self-center text-muted-foreground" />
								<span className="text-base text-muted-foreground">
									No DNS providers yet. Add a Cloudflare token to enable DNS-01
									certs.
								</span>
								{canManage && <HandleDnsProvider onDone={refetch} />}
							</div>
						) : (
							<div className="flex min-h-[25vh] flex-col gap-4">
								<div className="flex flex-col gap-4 rounded-lg">
									{data?.map((provider) => (
										<div
											key={provider.dnsProviderId}
											className="flex w-full items-center justify-between rounded-lg bg-sidebar p-1"
										>
											<div className="flex w-full items-center justify-between rounded-lg border bg-background p-3.5">
												<span className="flex items-center gap-2 font-medium text-sm">
													{provider.name}
													<Badge variant="secondary" className="capitalize">
														{provider.provider}
													</Badge>
													{provider.hasToken ? (
														<Badge
															variant="outline"
															className="border-emerald-500/40 text-emerald-500"
														>
															token set
														</Badge>
													) : (
														<Badge
															variant="outline"
															className="border-destructive/40 text-destructive"
														>
															no token
														</Badge>
													)}
													{provider.enabled && (
														<Badge
															variant="outline"
															className="border-emerald-500/40 text-emerald-500"
														>
															DNS-01 available
														</Badge>
													)}
												</span>
												{canManage && (
													<div className="flex flex-row gap-1">
														{provider.enabled ? (
															<DialogAction
																title="Deactivate DNS-01"
																description="Removes the DNS-01 resolver. The default HTTP-01 resolver (used by existing domains) is unaffected. Traefik restarts briefly."
																onClick={async () => {
																	await deactivate({
																		dnsProviderId: provider.dnsProviderId,
																	})
																		.then(async () => {
																			toast.success("DNS-01 deactivated");
																			await refetch();
																		})
																		.catch((e) =>
																			toast.error("Error", {
																				description: e.message,
																			}),
																		);
																}}
															>
																<Button variant="outline" size="sm">
																	Deactivate
																</Button>
															</DialogAction>
														) : (
															<DialogAction
																title="Activate DNS-01"
																description="Adds a DNS-01 resolver (letsencrypt-dns) using this provider — for wildcard certs and future HA ingress. The default HTTP-01 resolver stays the default, so existing domains are unaffected. Traefik restarts briefly to apply."
																onClick={async () => {
																	await activate({
																		dnsProviderId: provider.dnsProviderId,
																	})
																		.then(async () => {
																			toast.success("DNS-01 activated");
																			await refetch();
																		})
																		.catch((e) =>
																			toast.error("Error", {
																				description: e.message,
																			}),
																		);
																}}
															>
																<Button variant="secondary" size="sm">
																	Activate DNS-01
																</Button>
															</DialogAction>
														)}
														<HandleDnsProvider
															dnsProviderId={provider.dnsProviderId}
															name={provider.name}
															onDone={refetch}
														/>
														<DialogAction
															title="Delete DNS provider"
															description="Are you sure you want to delete this DNS provider?"
															type="destructive"
															onClick={async () => {
																await remove({
																	dnsProviderId: provider.dnsProviderId,
																})
																	.then(async () => {
																		toast.success("DNS provider deleted");
																		await refetch();
																	})
																	.catch((e) =>
																		toast.error("Error deleting provider", {
																			description: e.message,
																		}),
																	);
															}}
														>
															<Button
																variant="ghost"
																size="icon"
																className="group hover:bg-red-500/10"
																isLoading={isRemoving}
															>
																<Trash2 className="size-3.5 text-primary group-hover:text-red-500" />
															</Button>
														</DialogAction>
													</div>
												)}
											</div>
										</div>
									))}
								</div>
								{canManage && (
									<div className="flex justify-end">
										<HandleDnsProvider onDone={refetch} />
									</div>
								)}
							</div>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
