import {
	Loader2,
	Network,
	Plus,
	RefreshCw,
	Shield,
	Trash2,
} from "lucide-react";
import { useState } from "react";
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

export const ShowNetworkPolicies = () => {
	const { data, refetch, isLoading } = api.nomad.getNetworkTopology.useQuery();
	const utils = api.useUtils();

	const setIsolation = api.nomad.setProjectIsolation.useMutation();
	const createPolicy = api.nomad.createNetworkPolicy.useMutation();
	const removePolicy = api.nomad.removeNetworkPolicy.useMutation();
	const applyPolicies = api.nomad.applyNetworkPolicies.useMutation();

	const [source, setSource] = useState<string>("");
	const [target, setTarget] = useState<string>("");

	const projects = data?.projects ?? [];
	const policies = data?.policies ?? [];
	const meshByProject = data?.meshByProject ?? {};
	const nameOf = (id: string) =>
		projects.find((p) => p.projectId === id)?.name ?? id;

	const isolatedProjects = projects.filter((p) => p.isolated);

	const toggleIsolation = async (projectId: string, isolated: boolean) => {
		try {
			await setIsolation.mutateAsync({ projectId, isolated });
			toast.success(
				isolated
					? "Project isolated — redeploy its services to join the mesh"
					: "Project isolation disabled",
			);
			refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to update");
		}
	};

	const addRule = async () => {
		if (!source || !target) return;
		try {
			await createPolicy.mutateAsync({
				sourceProjectId: source,
				targetProjectId: target,
			});
			toast.success("Allow-rule added");
			setSource("");
			setTarget("");
			refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to add rule");
		}
	};

	const deleteRule = async (networkPolicyId: string) => {
		try {
			await removePolicy.mutateAsync({ networkPolicyId });
			refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to remove");
		}
	};

	const resync = async () => {
		try {
			const res = await applyPolicies.mutateAsync();
			toast.success(
				`Intentions synced (${res.applied} applied, ${res.pruned} pruned)`,
			);
			utils.nomad.getNetworkTopology.invalidate();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Sync failed");
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8">
				<Loader2 className="h-6 w-6 animate-spin" />
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<Card className="bg-sidebar rounded-xl">
				<CardHeader className="flex flex-row items-start justify-between gap-4">
					<div className="space-y-1.5">
						<CardTitle className="flex items-center gap-2 text-xl">
							<Shield className="h-5 w-5" />
							Network policies
						</CardTitle>
						<CardDescription>
							Isolate a project to run its services in the Consul Connect mesh.
							Isolated services accept traffic only from their own project and
							from projects you explicitly allow below — everything else is
							denied. Toggle isolation, then redeploy the project's services.
						</CardDescription>
					</div>
					<Button
						type="button"
						variant="secondary"
						onClick={resync}
						disabled={applyPolicies.isPending}
					>
						{applyPolicies.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<RefreshCw className="mr-2 h-4 w-4" />
						)}
						Re-sync intentions
					</Button>
				</CardHeader>
				<CardContent>
					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Project</TableHead>
									<TableHead>Isolated</TableHead>
									<TableHead>Mesh services</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{projects.length > 0 ? (
									projects.map((p) => (
										<TableRow key={p.projectId}>
											<TableCell className="font-medium">{p.name}</TableCell>
											<TableCell>
												<Switch
													checked={p.isolated}
													disabled={setIsolation.isPending}
													onCheckedChange={(v) =>
														toggleIsolation(p.projectId, v === true)
													}
												/>
											</TableCell>
											<TableCell>
												{(meshByProject[p.projectId] ?? []).length > 0 ? (
													<div className="flex flex-wrap gap-1">
														{(meshByProject[p.projectId] ?? []).map((s) => (
															<Badge key={s} variant="outline">
																{s}
															</Badge>
														))}
													</div>
												) : (
													<span className="text-muted-foreground text-xs">
														{p.isolated ? "none deployed yet" : "—"}
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
											No projects.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
				</CardContent>
			</Card>

			<Card className="bg-sidebar rounded-xl">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-lg">
						<Network className="h-5 w-5" />
						Allow-rules
					</CardTitle>
					<CardDescription>
						Let one project's services reach another isolated project. Rules are
						directional: source → target.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="flex flex-wrap items-center gap-2">
						<Select value={source} onValueChange={setSource}>
							<SelectTrigger className="w-[200px]">
								<SelectValue placeholder="Source project" />
							</SelectTrigger>
							<SelectContent>
								{projects.map((p) => (
									<SelectItem key={p.projectId} value={p.projectId}>
										{p.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<span className="text-muted-foreground">→</span>
						<Select value={target} onValueChange={setTarget}>
							<SelectTrigger className="w-[200px]">
								<SelectValue placeholder="Target project (isolated)" />
							</SelectTrigger>
							<SelectContent>
								{isolatedProjects.map((p) => (
									<SelectItem key={p.projectId} value={p.projectId}>
										{p.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							type="button"
							onClick={addRule}
							disabled={!source || !target || createPolicy.isPending}
						>
							<Plus className="mr-2 h-4 w-4" />
							Add
						</Button>
					</div>

					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Source</TableHead>
									<TableHead>Target</TableHead>
									<TableHead className="text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{policies.length > 0 ? (
									policies.map((rule) => (
										<TableRow key={rule.networkPolicyId}>
											<TableCell className="font-medium">
												{nameOf(rule.sourceProjectId)}
											</TableCell>
											<TableCell>{nameOf(rule.targetProjectId)}</TableCell>
											<TableCell className="text-right">
												<Button
													type="button"
													variant="ghost"
													size="sm"
													className="text-destructive hover:text-destructive"
													disabled={removePolicy.isPending}
													onClick={() => deleteRule(rule.networkPolicyId)}
												>
													<Trash2 className="h-4 w-4" />
												</Button>
											</TableCell>
										</TableRow>
									))
								) : (
									<TableRow>
										<TableCell
											colSpan={3}
											className="text-center text-muted-foreground text-sm"
										>
											No allow-rules — isolated projects are fully sealed off
											from other projects.
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
