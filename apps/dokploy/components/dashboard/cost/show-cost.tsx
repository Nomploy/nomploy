import { CircleDollarSign, RefreshCw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

export const ShowCost = () => {
	const {
		data: report,
		isLoading,
		refetch,
	} = api.cost.report.useQuery();
	const { data: config } = api.cost.getConfig.useQuery();
	const { refetch: fetchSuggest, isFetching: suggesting } =
		api.cost.suggestPrices.useQuery(undefined, { enabled: false });
	const { mutateAsync: saveConfig, isPending: saving } =
		api.cost.saveConfig.useMutation();

	const { data: spend, refetch: refetchSpend } = api.cost.spend.useQuery(
		undefined,
		{ refetchInterval: 60000 },
	);

	const [typePrices, setTypePrices] = useState<Record<string, string>>({});
	const [nodePrices, setNodePrices] = useState<Record<string, string>>({});
	const [budget, setBudget] = useState("");

	// Seed the editable price maps from the saved config once it loads.
	useEffect(() => {
		if (!config) return;
		setTypePrices(
			Object.fromEntries(
				Object.entries(config.typePrices).map(([k, v]) => [k, String(v)]),
			),
		);
		setNodePrices(
			Object.fromEntries(
				Object.entries(config.nodePrices).map(([k, v]) => [k, String(v)]),
			),
		);
		setBudget(config.monthlyBudget ? String(config.monthlyBudget) : "");
	}, [config]);

	const currency = report?.currency ?? "EUR";
	const fmt = (n: number) =>
		`${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

	// Typed nodes are priced per server type; untyped (hub / manual) per node.
	const distinctTypes = useMemo(() => {
		const s = new Set<string>();
		for (const n of report?.nodes ?? [])
			if (n.serverType) s.add(n.serverType);
		return [...s].sort();
	}, [report]);
	const allNodes = useMemo(() => report?.nodes ?? [], [report]);

	const saveBudget = async () => {
		try {
			await saveConfig({
				monthlyBudget: budget.trim() === "" ? 0 : Math.max(0, Number(budget)),
			});
			toast.success("Budget saved");
			await refetchSpend();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save");
		}
	};

	const save = async () => {
		// A blank field means "no price here" (inherit the type price / unset) — drop
		// it rather than persisting Number("") === 0 as an explicit 0 override.
		const toNum = (m: Record<string, string>) =>
			Object.fromEntries(
				Object.entries(m)
					.filter(([, raw]) => raw.trim() !== "")
					.map(([k, raw]) => [k, Number(raw)] as const)
					.filter(([, v]) => Number.isFinite(v) && v >= 0),
			);
		try {
			await saveConfig({
				typePrices: toNum(typePrices),
				nodePrices: toNum(nodePrices),
				monthlyBudget: budget.trim() === "" ? 0 : Math.max(0, Number(budget)),
			});
			toast.success("Prices saved");
			await refetch();
			await refetchSpend();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save");
		}
	};

	const suggest = async () => {
		const res = await fetchSuggest();
		const s = res.data ?? {};
		if (Object.keys(s).length === 0) {
			toast.info("No Hetzner prices found (no matching autoscale group/token)");
			return;
		}
		setTypePrices((prev) => {
			const next = { ...prev };
			for (const [k, v] of Object.entries(s)) next[k] = String(v);
			return next;
		});
		toast.success(`Suggested ${Object.keys(s).length} price(s) from Hetzner`);
	};

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
			<div className="flex items-center gap-2">
				<CircleDollarSign className="size-6 text-muted-foreground" />
				<h1 className="text-2xl font-semibold">Cost</h1>
			</div>
			<p className="text-sm text-muted-foreground">
				Cluster run-rate from node prices, allocated to services by their
				reserved CPU + memory share and rolled up to projects.
			</p>

			{isLoading ? (
				<Skeleton className="h-64 w-full" />
			) : !report ? (
				<p className="text-muted-foreground">No data.</p>
			) : (
				<>
					{/* Summary */}
					<div className="grid gap-4 sm:grid-cols-3">
						<Card className="bg-background">
							<CardHeader className="pb-2">
								<CardDescription>Cluster run-rate</CardDescription>
								<CardTitle className="text-2xl">
									{fmt(report.totalMonthly)}
									<span className="ml-1 text-sm font-normal text-muted-foreground">
										/mo
									</span>
								</CardTitle>
							</CardHeader>
						</Card>
						<Card className="bg-background">
							<CardHeader className="pb-2">
								<CardDescription>Allocated to services</CardDescription>
								<CardTitle className="text-2xl">
									{fmt(report.allocatedMonthly)}
									<span className="ml-1 text-sm font-normal text-muted-foreground">
										/mo
									</span>
								</CardTitle>
							</CardHeader>
						</Card>
						<Card className="bg-background">
							<CardHeader className="pb-2">
								<CardDescription>Unallocated</CardDescription>
								<CardTitle className="text-2xl">
									{fmt(report.unallocatedMonthly)}
									<span className="ml-1 text-sm font-normal text-muted-foreground">
										/mo
									</span>
								</CardTitle>
								<CardDescription className="pt-1">
									{fmt(report.platformMonthly)} platform ·{" "}
									{fmt(report.idleMonthly)} idle
								</CardDescription>
							</CardHeader>
						</Card>
					</div>

					{report.unpricedNodes.length > 0 && (
						<p className="text-sm text-amber-600 dark:text-amber-500">
							{report.unpricedNodes.length} node(s) have no price — the run-rate
							is undercounted. Set prices below: {report.unpricedNodes.join(", ")}
							.
						</p>
					)}

					{/* This month: spend + projection vs budget */}
					{spend && (
						<Card className="bg-background">
							<CardHeader className="pb-2">
								<CardTitle className="text-lg">This month</CardTitle>
								<CardDescription>
									Estimated spend so far (day {spend.daysElapsed}/
									{spend.daysInMonth}) and the end-of-month projection, assuming
									a steady run-rate.
								</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-4">
								<div className="grid gap-4 sm:grid-cols-3">
									<div>
										<p className="text-sm text-muted-foreground">
											Spent so far
										</p>
										<p className="text-xl font-semibold">
											{fmt(spend.monthToDate)}
										</p>
									</div>
									<div>
										<p className="text-sm text-muted-foreground">
											Projected month-end
										</p>
										<p className="text-xl font-semibold">
											{fmt(spend.projectedMonthEnd)}
										</p>
									</div>
									<div className="space-y-1">
										<p className="text-sm text-muted-foreground">
											Monthly budget
										</p>
										<div className="flex gap-2">
											<Input
												type="number"
												min={0}
												step="1"
												placeholder="none"
												value={budget}
												onChange={(e) => setBudget(e.target.value)}
												className="h-8"
											/>
											<Button
												type="button"
												size="sm"
												variant="outline"
												className="h-8 shrink-0"
												onClick={saveBudget}
												disabled={saving}
											>
												Save
											</Button>
										</div>
									</div>
								</div>
								{spend.budget > 0 && (
									<div className="space-y-1">
										<div className="h-2 w-full overflow-hidden rounded-full bg-muted">
											<div
												className={`h-full ${spend.budgetUsedFraction > 1 ? "bg-destructive" : "bg-emerald-600"}`}
												style={{
													width: `${Math.min(100, spend.budgetUsedFraction * 100)}%`,
												}}
											/>
										</div>
										<p
											className={`text-xs ${spend.budgetUsedFraction > 1 ? "text-destructive" : "text-muted-foreground"}`}
										>
											Projected uses {Math.round(spend.budgetUsedFraction * 100)}%
											of the {fmt(spend.budget)} budget
											{spend.budgetUsedFraction > 1 ? " — over budget" : ""}.
										</p>
									</div>
								)}
							</CardContent>
						</Card>
					)}

					{/* Prices editor */}
					<Card className="bg-background">
						<CardHeader>
							<CardTitle className="text-lg">Node prices (€/month)</CardTitle>
							<CardDescription>
								Typed nodes are priced per server type; the hub and manual nodes
								per node. Net monthly price.
							</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-4">
							{distinctTypes.length > 0 && (
								<div>
									<div className="mb-2 flex items-center justify-between">
										<Label>Per server type</Label>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={suggest}
											disabled={suggesting}
										>
											<RefreshCw className="mr-2 size-3.5" />
											Suggest from Hetzner
										</Button>
									</div>
									<div className="grid gap-3 sm:grid-cols-3">
										{distinctTypes.map((t) => (
											<div key={t} className="space-y-1">
												<Label className="text-xs text-muted-foreground">
													{t}
												</Label>
												<Input
													type="number"
													min={0}
													step="0.01"
													value={typePrices[t] ?? ""}
													onChange={(e) =>
														setTypePrices((p) => ({ ...p, [t]: e.target.value }))
													}
												/>
											</div>
										))}
									</div>
								</div>
							)}
							{allNodes.length > 0 && (
								<div>
									<Label>Per node (overrides the type price)</Label>
									<p className="mb-2 text-xs text-muted-foreground">
										Leave blank to use the server-type price. Set a node's own
										price when it differs — e.g. the hub / control-plane box.
									</p>
									<div className="grid gap-3 sm:grid-cols-3">
										{allNodes.map((n) => (
											<div key={n.id} className="space-y-1">
												<Label className="text-xs text-muted-foreground">
													{n.name}
													{n.serverType ? ` · ${n.serverType}` : ""}
												</Label>
												<Input
													type="number"
													min={0}
													step="0.01"
													placeholder={
														n.serverType && typePrices[n.serverType]
															? `type: ${typePrices[n.serverType]}`
															: "0.00"
													}
													value={nodePrices[n.name] ?? ""}
													onChange={(e) =>
														setNodePrices((p) => ({
															...p,
															[n.name]: e.target.value,
														}))
													}
												/>
											</div>
										))}
									</div>
								</div>
							)}
							<div>
								<Button type="button" onClick={save} disabled={saving}>
									<Save className="mr-2 size-4" />
									Save prices
								</Button>
							</div>
						</CardContent>
					</Card>

					{/* Nodes */}
					<Card className="bg-background">
						<CardHeader>
							<CardTitle className="text-lg">Nodes</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Node</TableHead>
										<TableHead>Pool</TableHead>
										<TableHead>Type</TableHead>
										<TableHead className="text-right">CPU resv</TableHead>
										<TableHead className="text-right">Mem resv</TableHead>
										<TableHead className="text-right">€/mo</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{report.nodes.map((n) => (
										<TableRow key={n.id}>
											<TableCell className="font-medium">{n.name}</TableCell>
											<TableCell>{n.nodePool}</TableCell>
											<TableCell>
												{n.serverType ?? (
													<span className="text-muted-foreground">—</span>
												)}
											</TableCell>
											<TableCell className="text-right">
												{n.cpuReservedPct}%
											</TableCell>
											<TableCell className="text-right">
												{n.memReservedPct}%
											</TableCell>
											<TableCell className="text-right">
												{n.monthly > 0 ? (
													fmt(n.monthly)
												) : (
													<Badge variant="secondary">unpriced</Badge>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>

					{/* Per-project rollup */}
					<Card className="bg-background">
						<CardHeader>
							<CardTitle className="text-lg">By project</CardTitle>
							<CardDescription>
								Each service's share of its node's cost (reserved CPU + memory).
							</CardDescription>
						</CardHeader>
						<CardContent>
							{report.projects.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									No priced services yet — set node prices above.
								</p>
							) : (
								<Accordion type="multiple" className="w-full">
									{report.projects.map((p) => (
										<AccordionItem key={p.projectId} value={p.projectId}>
											<AccordionTrigger>
												<div className="flex w-full items-center justify-between pr-3">
													<span>{p.projectName}</span>
													<span className="text-muted-foreground">
														{fmt(p.monthly)}/mo
													</span>
												</div>
											</AccordionTrigger>
											<AccordionContent>
												<Table>
													<TableBody>
														{p.services.map((s) => (
															<TableRow key={s.appName}>
																<TableCell className="font-medium">
																	{s.name}
																</TableCell>
																<TableCell className="text-muted-foreground">
																	{s.environmentName}
																</TableCell>
																<TableCell className="text-muted-foreground">
																	{s.type}
																</TableCell>
																<TableCell className="text-right">
																	{fmt(s.monthly)}/mo
																</TableCell>
															</TableRow>
														))}
													</TableBody>
												</Table>
											</AccordionContent>
										</AccordionItem>
									))}
								</Accordion>
							)}
						</CardContent>
					</Card>
				</>
			)}
		</div>
	);
};
