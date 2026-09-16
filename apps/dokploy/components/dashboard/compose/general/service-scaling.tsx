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
 * Per-service scaling for a Nomad compose, set from the panel instead of editing
 * deploy.replicas / x-nomad-scaling in the YAML. Only takes effect in independent
 * deploy mode (shared mode runs one group at count=1). Merged over the compose file
 * at deploy time (UI wins). See applyServiceScalingOverrides in builders/nomad.ts.
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
	const [scaling, setScaling] = useState<ScalingMap>({});

	useEffect(() => {
		if (data) setScaling((data.serviceScaling as ScalingMap) ?? {});
	}, [data]);

	const independent = data?.deployMode === "independent";

	const cfg = (name: string): ServiceConfig => scaling[name] ?? {};
	const patch = (name: string, next: ServiceConfig) =>
		setScaling((s) => ({ ...s, [name]: { ...s[name], ...next } }));
	const patchAuto = (name: string, next: Partial<Autoscaling>) => {
		const cur = cfg(name).autoscaling ?? { enabled: false, min: 1, max: 3 };
		patch(name, { autoscaling: { ...cur, ...next } });
	};

	const save = async () => {
		try {
			await update.mutateAsync({ composeId, serviceScaling: scaling });
			toast.success("Scaling saved — redeploy to apply");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Per-service scaling</CardTitle>
				<CardDescription>
					Set each service's replica count or autoscaling here instead of
					editing
					<code className="mx-1">deploy.replicas</code>/
					<code className="mx-1">x-nomad-scaling</code> in the compose file.
					{independent
						? " Redeploy to apply."
						: " Enable “Independent scaling” above for this to take effect (shared mode runs the whole app as one unit)."}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{servicesLoading && (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="h-4 w-4 animate-spin" /> Loading services…
					</div>
				)}
				{!servicesLoading && (!services || services.length === 0) && (
					<p className="text-muted-foreground text-sm">
						No services found. Fetch/deploy the compose first.
					</p>
				)}
				{services?.map((name) => {
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
										onCheckedChange={(enabled) => patchAuto(name, { enabled })}
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

				{services && services.length > 0 && (
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
				)}
			</CardContent>
		</Card>
	);
};
