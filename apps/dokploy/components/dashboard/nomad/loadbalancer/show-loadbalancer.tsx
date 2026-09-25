import { Loader2, Network } from "lucide-react";
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

/**
 * HA "LoadBalancer": a Traefik system job on every node tagged nomploy_lb=true
 * (the hub is excluded — it runs the standalone Traefik). Deploy stands up the
 * pool; each member serves routes from the local Consul catalog and shared TLS
 * certs from Consul KV.
 */
export const ShowLoadBalancer = () => {
	const { data, refetch, isPending } = api.nomad.getLoadBalancerStatus.useQuery(
		undefined,
		{
			refetchInterval: 10000,
		},
	);
	const deploy = api.nomad.deployLoadBalancer.useMutation();
	const stop = api.nomad.stopLoadBalancer.useMutation();
	const syncCerts = api.nomad.syncLoadBalancerCerts.useMutation();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canManage = !!permissions?.server?.create;

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="flex flex-col gap-0.5">
					<CardTitle className="flex flex-row gap-2 text-xl">
						<Network className="size-5 self-center text-muted-foreground" />
						Load Balancer (HA ingress)
					</CardTitle>
					<CardDescription>
						Runs Traefik on every node tagged <code>nomploy_lb=true</code> — an
						active/active ingress pool (the hub is excluded). Members serve
						routes from the Consul catalog and shared certs from Consul KV.
					</CardDescription>
				</div>
				{canManage && (
					<div className="flex flex-row gap-2">
						<Button
							size="sm"
							isLoading={deploy.isPending}
							onClick={async () => {
								await deploy
									.mutateAsync()
									.then(async (r) => {
										toast.success("Load balancer deployed", {
											description: `${r.certCount} cert(s) synced to the shared store`,
										});
										await refetch();
									})
									.catch((e) =>
										toast.error("Deploy failed", { description: e.message }),
									);
							}}
						>
							{data?.deployed ? "Redeploy" : "Deploy"}
						</Button>
						{data?.deployed && (
							<Button
								size="sm"
								variant="outline"
								isLoading={syncCerts.isPending}
								onClick={async () => {
									await syncCerts
										.mutateAsync()
										.then((r) =>
											toast.success("Certs synced", {
												description: `${r.certCount} cert(s) refreshed in the shared store`,
											}),
										)
										.catch((e) =>
											toast.error("Cert sync failed", {
												description: e.message,
											}),
										);
								}}
							>
								Sync certs
							</Button>
						)}
						{data?.deployed && (
							<DialogAction
								title="Stop load balancer"
								description="Removes the Traefik HA pool from every tagged node. The hub's standalone Traefik keeps serving. Continue?"
								type="destructive"
								onClick={async () => {
									await stop
										.mutateAsync()
										.then(async () => {
											toast.success("Load balancer stopped");
											await refetch();
										})
										.catch((e) =>
											toast.error("Stop failed", { description: e.message }),
										);
								}}
							>
								<Button size="sm" variant="outline" isLoading={stop.isPending}>
									Stop
								</Button>
							</DialogAction>
						)}
					</div>
				)}
			</CardHeader>
			<CardContent>
				{isPending ? (
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="size-4 animate-spin" /> Loading…
					</div>
				) : !data?.deployed ? (
					<p className="text-muted-foreground text-sm">
						Not deployed. Tag the server nodes you want in the pool with{" "}
						<code>nomploy_lb=true</code>, then Deploy. (The hub is intentionally
						excluded.)
					</p>
				) : (
					<div className="flex flex-col gap-2">
						{data.members.map((m) => (
							<div
								key={m.node}
								className="flex items-center justify-between rounded-lg border p-2.5 text-sm"
							>
								<span className="font-medium">{m.node}</span>
								<Badge
									variant="outline"
									className={
										m.status === "running"
											? "border-emerald-500/40 text-emerald-500"
											: "border-destructive/40 text-destructive"
									}
								>
									{m.status}
								</Badge>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
