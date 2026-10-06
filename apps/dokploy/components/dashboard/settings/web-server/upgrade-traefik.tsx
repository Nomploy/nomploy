import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
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
import { api } from "@/utils/api";

const VERSION_RE = /^\d+\.\d+\.\d+$/;

interface Props {
	serverId?: string;
}

export const UpgradeTraefik = ({ serverId }: Props) => {
	const { data, refetch } = api.settings.getTraefikVersion.useQuery({
		serverId,
	});
	const { mutateAsync: upgradeTraefik, isPending } =
		api.settings.upgradeTraefik.useMutation();

	const [version, setVersion] = useState("");

	// Prefill the input with the current version once it loads.
	useEffect(() => {
		if (data?.version) {
			setVersion(data.version);
		}
	}, [data?.version]);

	const isValid = VERSION_RE.test(version.trim());
	const isUnchanged = version.trim() === data?.version;

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-lg">Traefik Version</CardTitle>
				<CardDescription>
					Current version: {data?.version ?? "..."}. Upgrade the Traefik image
					used for ingress.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end">
				<div className="flex w-full flex-col gap-2 sm:max-w-xs">
					<Label htmlFor="traefik-version">Target version</Label>
					<Input
						id="traefik-version"
						placeholder="3.6.7"
						value={version}
						onChange={(e) => setVersion(e.target.value)}
					/>
				</div>
				<DialogAction
					title="Upgrade Traefik"
					description={
						<div className="space-y-4">
							<AlertBlock type="warning">
								Upgrading recreates Traefik and briefly interrupts ingress while
								the new image is pulled and the container is recreated.
							</AlertBlock>
							<p>
								Are you sure you want to upgrade Traefik to {version.trim()}?
							</p>
						</div>
					}
					onClick={async () => {
						try {
							await upgradeTraefik({ version: version.trim(), serverId });
							toast.success(
								"Traefik upgrade started. Ingress may briefly be interrupted.",
							);
							refetch();
						} catch (error) {
							toast.error(
								(error as Error)?.message || "Failed to upgrade Traefik.",
							);
						}
					}}
					type="default"
					disabled={!isValid || isUnchanged || isPending}
				>
					<Button
						variant="secondary"
						isLoading={isPending}
						disabled={!isValid || isUnchanged || isPending}
					>
						Upgrade
					</Button>
				</DialogAction>
			</CardContent>
		</Card>
	);
};

export default UpgradeTraefik;
