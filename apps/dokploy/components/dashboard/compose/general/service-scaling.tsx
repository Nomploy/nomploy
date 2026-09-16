import { Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { api } from "@/utils/api";

interface Props {
	composeId: string;
}

type Autoscaling = {
	enabled: boolean;
	min: number;
	max: number;
	cpuTarget?: number;
	memoryTarget?: number;
};
type ServiceConfig = { replicas?: number; autoscaling?: Autoscaling };
type ScalingMap = Record<string, ServiceConfig>;

/**
 * Scaling for a Nomad compose, set from the panel instead of editing the YAML.
 *  - Shared mode: one control that autoscales the whole app (the single group) as a
 *    unit — best for a single-service or all-stateless compose.
 *  - Independent mode: per-service replicas / autoscaling.
 * Merged over the compose file at deploy time (UI wins). Redeploy to apply.
 */
export const ShowServiceScaling = ({ composeId }: Props) => {
	const { data, refetch } = api.compose.one.useQuery(
		{ composeId },
		{ enabled: !!composeId },
	);
	const { data: services, isLoading: servicesLoading } =
		api.compose.loadServices.useQuery(
			{ composeId, type: "cache" },
			{ enabled: !!composeId },
		);
	const update = api.compose.update.useMutation();

	const independent = data?.deployMode === "independent";

	// Per-service state (independent mode).
	const [scaling, setScaling] = useState<ScalingMap>({});
	// Whole-app state (shared mode).
	const [group, setGroup] = useState<Autoscaling>({
		enabled: false,
		min: 1,
		max: 3,
	});

	useEffect(() => {
		if (!data) return;
		setScaling((data.serviceScaling as ScalingMap) ?? {});
		setGroup({
			enabled: data.autoscalingEnabled ?? false,
			min: data.minReplicas ?? 1,
			max: data.maxReplicas ?? 3,
			cpuTarget: data.autoscaleCpuTarget ?? undefined,
		});
	}, [data]);

	const cfg = (name: string): ServiceConfig => scaling[name] ?? {};
	const patch = (name: string, next: ServiceConfig) =>
		setScaling((s) => ({ ...s, [name]: { ...s[name], ...next } }));
	const patchAuto = (name: string, next: Partial<Autoscaling>) => {
		const cur = cfg(name).autoscaling ?? { enabled: false, min: 1, max: 3 };
		patch(name, { autoscaling: { ...cur, ...next } });
	};

	const save = async () => {
		try {
			if (independent) {
				await update.mutateAsync({ composeId, serviceScaling: scaling });
			} else {
				await update.mutateAsync({
					composeId,
					autoscalingEnabled: group.enabled,
					minReplicas: group.min,
					maxReplicas: group.max,
					autoscaleCpuTarget: group.cpuTarget ?? null,
				});
			}
			toast.success("Scaling saved — redeploy to apply");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Scaling</CardTitle>
				<CardDescription>
					{independent
						? "Set each service's replica count or autoscaling. Redeploy to apply."
						: "Autoscale the whole app (all services scale together as one group). For per-service scaling, turn on “Independent scaling” above. Redeploy to apply."}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{/* ── Shared mode: one whole-app autoscaling control ────────────── */}
				{!independent && (
					<div className="flex flex-col gap-3 rounded-md border p-3">
						<div className="flex items-center justify-between gap-3">
							<span className="font-medium text-sm">Autoscale the app</span>
							<Switch
								aria-label="Toggle app autoscaling"
								checked={group.enabled}
								onCheckedChange={(enabled) =>
									setGroup((g) => ({ ...g, enabled }))
								}
							/>
						</div>
						{group.enabled && (
							<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
								<div className="space-y-1">
									<Label className="text-xs">Min replicas</Label>
									<Input
										type="number"
										min={1}
										value={group.min}
										onChange={(e) =>
											setGroup((g) => ({
												...g,
												min: Number(e.target.value) || 1,
											}))
										}
									/>
								</div>
								<div className="space-y-1">
									<Label className="text-xs">Max replicas</Label>
									<Input
										type="number"
										min={1}
										value={group.max}
										onChange={(e) =>
											setGroup((g) => ({
												...g,
												max: Number(e.target.value) || 1,
											}))
										}
									/>
								</div>
								<div className="space-y-1">
									<Label className="text-xs">CPU target %</Label>
									<Input
										type="number"
										min={1}
										max={100}
										placeholder="70"
										value={group.cpuTarget ?? ""}
										onChange={(e) =>
											setGroup((g) => ({
												...g,
												cpuTarget: e.target.value
													? Number(e.target.value)
													: undefined,
											}))
										}
									/>
								</div>
							</div>
						)}
					</div>
				)}

				{/* ── Independent mode: per-service controls ────────────────────── */}
				{independent && servicesLoading && (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="h-4 w-4 animate-spin" /> Loading services…
					</div>
				)}
				{independent &&
					!servicesLoading &&
					(!services || services.length === 0) && (
						<p className="text-muted-foreground text-sm">
							No services found. Fetch/deploy the compose first.
						</p>
					)}
				{independent &&
					services?.map((name) => {
						const c = cfg(name);
						const auto = c.autoscaling;
						const autoOn = !!auto?.enabled;
						return (
							<div
								key={name}
								className="flex flex-col gap-3 rounded-md border p-3"
							>
								<div className="flex flex-wrap items-center justify-between gap-3">
									<span className="font-medium font-mono text-sm">{name}</span>
									<div className="flex items-center gap-2">
										<Label
											htmlFor={`auto-${name}`}
											className="text-muted-foreground text-xs"
										>
											Autoscale
										</Label>
										<Switch
											id={`auto-${name}`}
											checked={autoOn}
											onCheckedChange={(enabled) =>
												patchAuto(name, { enabled })
											}
										/>
									</div>
								</div>

								{autoOn ? (
									<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
										<div className="space-y-1">
											<Label className="text-xs">Min replicas</Label>
											<Input
												type="number"
												min={1}
												value={auto?.min ?? 1}
												onChange={(e) =>
													patchAuto(name, { min: Number(e.target.value) || 1 })
												}
											/>
										</div>
										<div className="space-y-1">
											<Label className="text-xs">Max replicas</Label>
											<Input
												type="number"
												min={1}
												value={auto?.max ?? 3}
												onChange={(e) =>
													patchAuto(name, { max: Number(e.target.value) || 1 })
												}
											/>
										</div>
										<div className="space-y-1">
											<Label className="text-xs">CPU target %</Label>
											<Input
												type="number"
												min={1}
												max={100}
												placeholder="70"
												value={auto?.cpuTarget ?? ""}
												onChange={(e) =>
													patchAuto(name, {
														cpuTarget: e.target.value
															? Number(e.target.value)
															: undefined,
													})
												}
											/>
										</div>
									</div>
								) : (
									<div className="space-y-1 sm:max-w-[12rem]">
										<Label className="text-xs">Replicas</Label>
										<Input
											type="number"
											min={1}
											placeholder="1"
											value={c.replicas ?? ""}
											onChange={(e) =>
												patch(name, {
													replicas: e.target.value
														? Number(e.target.value)
														: undefined,
												})
											}
										/>
									</div>
								)}
							</div>
						);
					})}

				<div>
					<Button type="button" onClick={save} disabled={update.isPending}>
						{update.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Save className="mr-2 h-4 w-4" />
						)}
						{update.isPending ? "Saving…" : "Save"}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
