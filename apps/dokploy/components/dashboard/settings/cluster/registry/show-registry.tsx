import { Loader2, Package, Trash2 } from "lucide-react";
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
import { api } from "@/utils/api";
import { HandleRegistry } from "./handle-registry";
import { HandleSelfHostedRegistry } from "./handle-self-hosted-registry";
import { SelfHostedActions } from "./self-hosted-actions";

const STATUS_STYLE: Record<string, { label: string; className: string }> = {
	provisioning: {
		label: "Provisioning…",
		className: "border-amber-500/40 text-amber-600 dark:text-amber-400",
	},
	healthy: {
		label: "Healthy",
		className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
	},
	failed: {
		label: "Failed",
		className: "border-destructive/40 text-destructive",
	},
	not_found: {
		label: "No job",
		className: "border-muted-foreground/30 text-muted-foreground",
	},
	unknown: {
		label: "Unknown",
		className: "border-muted-foreground/30 text-muted-foreground",
	},
};

/** Live health badge for a self-hosted (zot) registry — polls the zot job's state. */
const SelfHostedStatus = ({ registryId }: { registryId: string }) => {
	const { data } = api.registry.selfHostedStatus.useQuery(
		{ registryId },
		{ refetchInterval: 8000 },
	);
	const style = STATUS_STYLE[data?.state ?? "unknown"] ?? STATUS_STYLE.unknown;
	return (
		<Badge
			variant="outline"
			className={style?.className}
			title={data?.message || undefined}
		>
			{data?.state === "provisioning" && (
				<Loader2 className="mr-1 size-3 animate-spin" />
			)}
			{style?.label}
		</Badge>
	);
};

export const ShowRegistry = () => {
	const { mutateAsync, isPending: isRemoving } =
		api.registry.remove.useMutation();
	const { data, isPending, refetch } = api.registry.all.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar  p-2.5 rounded-xl  max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md ">
					<CardHeader className="">
						<CardTitle className="text-xl flex flex-row gap-2">
							<Package className="size-6 text-muted-foreground self-center" />
							Docker Registry
						</CardTitle>
						<CardDescription>
							Manage your Docker Registry configurations
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-2 py-8 border-t">
						{isPending ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : (
							<>
								{data?.length === 0 ? (
									<div className="flex flex-col items-center gap-3  min-h-[25vh] justify-center">
										<Package className="size-8 self-center text-muted-foreground" />
										<span className="text-base text-muted-foreground text-center">
											You don't have any registry configurations
										</span>
										{permissions?.registry.create && (
											<div className="flex flex-row flex-wrap gap-2 justify-center">
												<HandleRegistry />
												<HandleSelfHostedRegistry />
											</div>
										)}
									</div>
								) : (
									<div className="flex flex-col gap-4  min-h-[25vh]">
										<div className="flex flex-col gap-4 rounded-lg ">
											{data?.map((registry, index) => (
												<div
													key={registry.registryId}
													className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg"
												>
													<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border  w-full">
														<div className="flex items-center justify-between">
															<div className="flex gap-2 flex-col">
																<span className="flex items-center gap-2 text-sm font-medium">
																	{index + 1}. {registry.registryName}
																	{registry.registryType === "selfHosted" ? (
																		<>
																			<Badge variant="secondary">
																				Self-hosted · zot
																			</Badge>
																			<SelfHostedStatus
																				registryId={registry.registryId}
																			/>
																		</>
																	) : (
																		<Badge variant="outline">External</Badge>
																	)}
																</span>
																{registry.registryUrl && (
																	<div className="text-xs text-muted-foreground">
																		{registry.registryUrl}
																	</div>
																)}
															</div>
														</div>

														<div className="flex flex-row gap-1">
															{registry.registryType === "selfHosted" ? (
																<SelfHostedActions
																	registryId={registry.registryId}
																	url={registry.registryUrl}
																/>
															) : (
																<HandleRegistry
																	registryId={registry.registryId}
																/>
															)}

															{permissions?.registry.delete && (
																<DialogAction
																	title="Delete Registry"
																	description="Are you sure you want to delete this registry configuration?"
																	type="destructive"
																	onClick={async () => {
																		await mutateAsync({
																			registryId: registry.registryId,
																		})
																			.then(() => {
																				toast.success(
																					"Registry configuration deleted successfully",
																				);
																				refetch();
																			})
																			.catch(() => {
																				toast.error(
																					"Error deleting registry configuration",
																				);
																			});
																	}}
																>
																	<Button
																		variant="ghost"
																		size="icon"
																		className="group hover:bg-red-500/10 "
																		isLoading={isRemoving}
																	>
																		<Trash2 className="size-4 text-primary group-hover:text-red-500" />
																	</Button>
																</DialogAction>
															)}
														</div>
													</div>
												</div>
											))}
										</div>

										{permissions?.registry.create && (
											<div className="flex flex-row gap-2 flex-wrap w-full justify-end mr-4">
												<HandleSelfHostedRegistry />
												<HandleRegistry />
											</div>
										)}
									</div>
								)}
							</>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
