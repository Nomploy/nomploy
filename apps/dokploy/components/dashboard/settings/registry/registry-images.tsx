import { Boxes, Loader2, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

// Tailwind classes per Trivy severity for the CVE badges.
const SEVERITY_CLASS: Record<string, string> = {
	CRITICAL: "bg-red-600 text-white hover:bg-red-600",
	HIGH: "bg-orange-500 text-white hover:bg-orange-500",
	MEDIUM: "bg-amber-500 text-white hover:bg-amber-500",
	LOW: "bg-muted text-muted-foreground",
	UNKNOWN: "bg-muted text-muted-foreground",
	NONE: "bg-emerald-500 text-white hover:bg-emerald-500",
};
const severityClass = (s?: string) =>
	SEVERITY_CLASS[(s || "").toUpperCase()] ?? "bg-muted text-muted-foreground";

const fmtSize = (n: number): string => {
	if (!n) return "—";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(i === 0 || v >= 10 ? 0 : 1)} ${units[i]}`;
};

/**
 * Browse + manage the built-in (zot) registry's images: repositories, their tags
 * with size + digest, and per-tag delete. Talks to the registry's /v2 API via the
 * nomad router (server-side, so the overlay address is reachable).
 */
export const ShowRegistryImages = () => {
	const { data, isLoading, isError, error, refetch, isRefetching } =
		api.nomad.listRegistryImages.useQuery(undefined, {
			refetchOnWindowFocus: false,
		});
	const del = api.nomad.deleteRegistryImage.useMutation();
	// Which repo:tag is being deleted, so only its row spins.
	const [deleting, setDeleting] = useState<string | null>(null);
	// The image whose vulnerability scan is open in the dialog.
	const [scan, setScan] = useState<{ repo: string; tag: string } | null>(null);
	const vulns = api.nomad.getImageVulnerabilities.useQuery(
		{ repo: scan?.repo ?? "", reference: scan?.tag ?? "" },
		{ enabled: !!scan, retry: false },
	);

	const doDelete = async (repo: string, tag: string) => {
		const key = `${repo}:${tag}`;
		setDeleting(key);
		try {
			await del.mutateAsync({ repo, reference: tag });
			toast.success(`Deleted ${key}`);
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Delete failed");
		} finally {
			setDeleting(null);
		}
	};

	const repos = data?.repos ?? [];

	return (
		<>
			<Card className="bg-background">
				<CardHeader className="flex flex-row items-start justify-between gap-4">
					<div className="space-y-1.5">
						<CardTitle className="flex items-center gap-2 text-xl">
							<Boxes className="size-5" />
							Images
						</CardTitle>
						<CardDescription>
							Repositories and tags in the built-in registry. Deleting a tag
							untags it immediately (running allocations keep working); disk
							space is reclaimed by the registry's garbage collection.
						</CardDescription>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label="Refresh images"
						title="Refresh images"
						onClick={() => refetch()}
						disabled={isRefetching}
					>
						<RefreshCw
							className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`}
						/>
					</Button>
				</CardHeader>
				<CardContent>
					{isLoading ? (
						<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" /> Loading images…
						</div>
					) : isError ? (
						<div className="py-6 text-destructive text-sm">
							Couldn't load images: {error?.message ?? "unknown error"}
						</div>
					) : repos.length === 0 ? (
						<div className="py-6 text-muted-foreground text-sm">
							No images yet. Push one with{" "}
							<code>docker push &lt;address&gt;/nomploy/&lt;image&gt;</code>.
						</div>
					) : (
						<div className="overflow-x-auto rounded-lg border">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Repository</TableHead>
										<TableHead>Tag</TableHead>
										<TableHead>Size</TableHead>
										<TableHead>Digest</TableHead>
										<TableHead className="text-right">Actions</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{repos.flatMap((r) =>
										r.tags.length === 0
											? [
													<TableRow key={r.repo}>
														<TableCell className="font-medium">
															{r.repo}
														</TableCell>
														<TableCell
															colSpan={4}
															className="text-muted-foreground text-xs"
														>
															no tags
														</TableCell>
													</TableRow>,
												]
											: r.tags.map((t) => {
													const key = `${r.repo}:${t.tag}`;
													return (
														<TableRow key={key}>
															<TableCell className="font-medium">
																{r.repo}
															</TableCell>
															<TableCell>
																<Badge variant="outline">{t.tag}</Badge>
															</TableCell>
															<TableCell className="text-xs tabular-nums">
																{fmtSize(t.size)}
															</TableCell>
															<TableCell className="font-mono text-muted-foreground text-xs">
																{t.digest ? t.digest.slice(7, 19) : "—"}
															</TableCell>
															<TableCell className="text-right">
																<div className="flex items-center justify-end gap-1">
																	<Button
																		type="button"
																		variant="ghost"
																		size="sm"
																		aria-label={`Scan ${key}`}
																		title="Scan for vulnerabilities"
																		onClick={() =>
																			setScan({ repo: r.repo, tag: t.tag })
																		}
																	>
																		<ShieldAlert className="h-4 w-4" />
																	</Button>
																	<AlertDialog>
																		<AlertDialogTrigger asChild>
																			<Button
																				type="button"
																				variant="ghost"
																				size="sm"
																				className="text-destructive"
																				aria-label={`Delete ${key}`}
																				disabled={deleting === key}
																			>
																				{deleting === key ? (
																					<Loader2 className="h-4 w-4 animate-spin" />
																				) : (
																					<Trash2 className="h-4 w-4" />
																				)}
																			</Button>
																		</AlertDialogTrigger>
																		<AlertDialogContent>
																			<AlertDialogHeader>
																				<AlertDialogTitle>
																					Delete {key}?
																				</AlertDialogTitle>
																				<AlertDialogDescription>
																					This untags the image in the built-in
																					registry. Running allocations already
																					using it keep working; new pulls of
																					this tag will fail. Disk space is
																					reclaimed by garbage collection.
																				</AlertDialogDescription>
																			</AlertDialogHeader>
																			<AlertDialogFooter>
																				<AlertDialogCancel>
																					Cancel
																				</AlertDialogCancel>
																				<AlertDialogAction
																					className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
																					onClick={() =>
																						doDelete(r.repo, t.tag)
																					}
																				>
																					Delete
																				</AlertDialogAction>
																			</AlertDialogFooter>
																		</AlertDialogContent>
																	</AlertDialog>
																</div>
															</TableCell>
														</TableRow>
													);
												}),
									)}
								</TableBody>
							</Table>
						</div>
					)}
				</CardContent>
			</Card>

			<Dialog
				open={!!scan}
				onOpenChange={(o) => {
					if (!o) setScan(null);
				}}
			>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							Vulnerabilities — {scan ? `${scan.repo}:${scan.tag}` : ""}
						</DialogTitle>
						<DialogDescription>
							Trivy scan from the built-in registry.
						</DialogDescription>
					</DialogHeader>
					{vulns.isFetching ? (
						<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" /> Scanning…
						</div>
					) : !vulns.data || !vulns.data.available ? (
						<div className="py-6 text-muted-foreground text-sm">
							No scan data yet — vulnerability scanning may still be
							initializing (Trivy database download). Try again shortly.
						</div>
					) : (
						<div className="space-y-3">
							{vulns.data.summary && (
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<Badge
										className={severityClass(vulns.data.summary.MaxSeverity)}
									>
										max: {vulns.data.summary.MaxSeverity || "—"}
									</Badge>
									<span className="text-muted-foreground">
										{vulns.data.summary.Count} total
									</span>
									<Badge className={severityClass("CRITICAL")}>
										{vulns.data.summary.CriticalCount} critical
									</Badge>
									<Badge className={severityClass("HIGH")}>
										{vulns.data.summary.HighCount} high
									</Badge>
									<Badge className={severityClass("MEDIUM")}>
										{vulns.data.summary.MediumCount} medium
									</Badge>
									<Badge className={severityClass("LOW")}>
										{vulns.data.summary.LowCount} low
									</Badge>
								</div>
							)}
							{vulns.data.cves.length === 0 ? (
								<div className="py-4 text-emerald-600 text-sm">
									No known vulnerabilities 🎉
								</div>
							) : (
								<div className="max-h-[420px] overflow-auto rounded-lg border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Severity</TableHead>
												<TableHead>CVE</TableHead>
												<TableHead>Title</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{vulns.data.cves.map((c) => (
												<TableRow key={c.id}>
													<TableCell>
														<Badge className={severityClass(c.severity)}>
															{c.severity}
														</Badge>
													</TableCell>
													<TableCell className="font-mono text-xs">
														{c.id}
													</TableCell>
													<TableCell className="text-xs">{c.title}</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							)}
						</div>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
};
