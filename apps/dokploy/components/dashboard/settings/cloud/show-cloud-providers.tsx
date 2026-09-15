import { Cloud, CloudCog, Loader2, Trash2 } from "lucide-react";
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
import { HandleCloudProvider } from "./handle-cloud-provider";

export const ShowCloudProviders = () => {
	const { data, isPending, refetch } = api.cloudProvider.all.useQuery();
	const { mutateAsync, isPending: isRemoving } =
		api.cloudProvider.remove.useMutation();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canManage = !!permissions?.server?.create;

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-xl flex flex-row gap-2">
							<CloudCog className="size-6 text-sky-500 self-center" />
							Cloud Providers
						</CardTitle>
						<CardDescription>
							Register a cloud account once, then reference it from autoscaling
							groups and one-click Add node — instead of pasting the API token
							into every group.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-2 py-8 border-t">
						{isPending ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : data?.length === 0 ? (
							<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center">
								<Cloud className="size-8 self-center text-muted-foreground" />
								<span className="text-base text-muted-foreground">
									No cloud providers yet. Add one to power cluster autoscaling.
								</span>
								{canManage && <HandleCloudProvider />}
							</div>
						) : (
							<div className="flex flex-col gap-4 min-h-[25vh]">
								<div className="flex flex-col gap-4 rounded-lg">
									{data?.map((provider) => (
										<div
											key={provider.cloudProviderId}
											className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg"
										>
											<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border w-full">
												<div className="flex flex-col gap-1">
													<span className="text-sm font-medium flex items-center gap-2">
														{provider.name}
														<Badge variant="secondary" className="capitalize">
															{provider.provider}
														</Badge>
														{provider.hasToken ? (
															<Badge
																variant="outline"
																className="text-emerald-500 border-emerald-500/40"
															>
																token set
															</Badge>
														) : (
															<Badge
																variant="outline"
																className="text-destructive border-destructive/40"
															>
																no token
															</Badge>
														)}
													</span>
												</div>
												{canManage && (
													<div className="flex flex-row gap-1">
														<HandleCloudProvider
															cloudProviderId={provider.cloudProviderId}
														/>
														<DialogAction
															title="Delete Cloud Provider"
															description="Are you sure you want to delete this cloud provider? Autoscaling groups still using it must be reassigned first."
															type="destructive"
															onClick={async () => {
																await mutateAsync({
																	cloudProviderId: provider.cloudProviderId,
																})
																	.then(async () => {
																		toast.success("Cloud provider deleted");
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
										<HandleCloudProvider />
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
