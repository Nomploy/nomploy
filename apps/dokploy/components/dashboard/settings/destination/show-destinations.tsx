import { Database, FolderUp, Loader2, Star, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";
import { HandleDestinations } from "./handle-destinations";

export const ShowDestinations = () => {
	const { data, isPending, refetch } = api.destination.all.useQuery();
	const { mutateAsync, isPending: isRemoving } =
		api.destination.remove.useMutation();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const utils = api.useUtils();
	const { mutateAsync: setBackupDefaults, isPending: isSettingDefault } =
		api.destination.setBackupDefaults.useMutation();
	const saveDefaults = async (
		destinationId: string,
		isDefaultBackup: boolean,
		autoProtectNewDatabases: boolean,
	) => {
		await setBackupDefaults({
			destinationId,
			isDefaultBackup,
			autoProtectNewDatabases,
		})
			.then(() => {
				refetch();
				utils.backup.defaultDestination.invalidate();
			})
			.catch((e) => toast.error(e.message ?? "Error saving backup defaults"));
	};
	// With a single destination and none flagged, that one is the implicit default.
	const implicitDefault =
		data?.length === 1 && !data[0]?.isDefaultBackup
			? data[0]?.destinationId
			: undefined;
	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar  p-2.5 rounded-xl  max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md ">
					<CardHeader className="">
						<CardTitle className="text-xl flex flex-row gap-2">
							<Database className="size-6 text-muted-foreground self-center" />
							S3 Destinations
						</CardTitle>
						<CardDescription>
							Add your providers like AWS S3, Cloudflare R2, Wasabi,
							DigitalOcean Spaces etc.
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
										<FolderUp className="size-8 self-center text-muted-foreground" />
										<span className="text-base text-muted-foreground">
											To create a backup it is required to set at least 1
											provider.
										</span>
										{permissions?.destination.create && <HandleDestinations />}
									</div>
								) : (
									<div className="flex flex-col gap-4  min-h-[25vh]">
										<div className="flex flex-col gap-4 rounded-lg ">
											{data?.map((destination, index) => (
												<div
													key={destination.destinationId}
													className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg"
												>
													<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border  w-full">
														<div className="flex flex-col gap-1">
															<span className="text-sm">
																{index + 1}. {destination.name}
															</span>
															<span className="text-xs text-muted-foreground">
																Created at:{" "}
																{new Date(
																	destination.createdAt,
																).toLocaleDateString()}
															</span>
															{permissions?.destination.create && (
																<div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
																	{destination.isDefaultBackup ? (
																		<Badge className="gap-1">
																			<Star className="size-3" />
																			Default for backups
																		</Badge>
																	) : (
																		<Button
																			variant="outline"
																			size="sm"
																			className="h-6 px-2 text-xs"
																			disabled={isSettingDefault}
																			onClick={() =>
																				saveDefaults(
																					destination.destinationId,
																					true,
																					false,
																				)
																			}
																		>
																			<Star className="size-3" />
																			{implicitDefault ===
																			destination.destinationId
																				? "Default (only destination) — pin"
																				: "Set as backup default"}
																		</Button>
																	)}
																	{destination.isDefaultBackup && (
																		<div className="flex items-center gap-2 text-muted-foreground">
																			<Switch
																				id={`auto-protect-${destination.destinationId}`}
																				checked={
																					destination.autoProtectNewDatabases
																				}
																				disabled={isSettingDefault}
																				onCheckedChange={(v) =>
																					saveDefaults(
																						destination.destinationId,
																						true,
																						v,
																					)
																				}
																			/>
																			<label
																				htmlFor={`auto-protect-${destination.destinationId}`}
																			>
																				Auto-backup new databases
																			</label>
																		</div>
																	)}
																	{destination.isDefaultBackup && (
																		<button
																			type="button"
																			className="text-muted-foreground underline"
																			disabled={isSettingDefault}
																			onClick={() =>
																				saveDefaults(
																					destination.destinationId,
																					false,
																					false,
																				)
																			}
																		>
																			Unset default
																		</button>
																	)}
																</div>
															)}
														</div>
														<div className="flex flex-row gap-1">
															<HandleDestinations
																destinationId={destination.destinationId}
															/>
															{permissions?.destination.delete && (
																<DialogAction
																	title="Delete Destination"
																	description="Are you sure you want to delete this destination?"
																	type="destructive"
																	onClick={async () => {
																		await mutateAsync({
																			destinationId: destination.destinationId,
																		})
																			.then(() => {
																				toast.success(
																					"Destination deleted successfully",
																				);
																				refetch();
																			})
																			.catch(() => {
																				toast.error(
																					"Error deleting destination",
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

										{permissions?.destination.create && (
											<div className="flex flex-row gap-2 flex-wrap w-full justify-end mr-4">
												<HandleDestinations />
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
