import { Box, Save } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

interface Props {
	composeId: string;
}

/**
 * Settings for a "Nomad Pack" service: the pack to deploy, an optional custom
 * registry, and the pack variables (HCL, stored in composeFile). Deploy runs
 * `nomad-pack run` (see getBuildNomadPackCommand).
 */
export const ShowNomadPackForm = ({ composeId }: Props) => {
	const { data, refetch } = api.compose.one.useQuery({ composeId });
	const update = api.compose.update.useMutation();

	const [nomadPack, setNomadPack] = useState("");
	const [nomadPackRegistry, setNomadPackRegistry] = useState("");
	const [variables, setVariables] = useState("");

	useEffect(() => {
		if (!data) return;
		setNomadPack(data.nomadPack ?? "");
		setNomadPackRegistry(data.nomadPackRegistry ?? "");
		setVariables(data.composeFile ?? "");
	}, [data]);

	const save = async () => {
		if (!nomadPack.trim()) {
			toast.error("Enter a pack to deploy");
			return;
		}
		try {
			await update.mutateAsync({
				composeId,
				nomadPack: nomadPack.trim(),
				nomadPackRegistry: nomadPackRegistry.trim(),
				composeFile: variables,
			});
			toast.success("Pack settings saved");
			await refetch();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Box className="size-5" />
					Nomad Pack
				</CardTitle>
				<CardDescription>
					Deploy a{" "}
					<a
						href="https://github.com/hashicorp/nomad-pack-community-registry"
						target="_blank"
						rel="noreferrer"
						className="underline underline-offset-2"
					>
						Nomad Pack
					</a>{" "}
					by name from the community registry (or a custom git registry), with
					your variables. Deploy runs{" "}
					<code className="rounded bg-muted px-1">nomad-pack run</code>.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label>Pack</Label>
						<Input
							placeholder="e.g. traefik or hello_world"
							value={nomadPack}
							onChange={(e) => setNomadPack(e.target.value)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label>Custom registry (optional)</Label>
						<Input
							placeholder="git URL — blank uses the community registry"
							value={nomadPackRegistry}
							onChange={(e) => setNomadPackRegistry(e.target.value)}
						/>
					</div>
				</div>
				<div className="space-y-1.5">
					<Label>Variables (HCL)</Label>
					<Textarea
						className="min-h-[220px] font-mono text-xs"
						placeholder={'# pack variables, e.g.\ncount = 2\nregion = "global"'}
						value={variables}
						onChange={(e) => setVariables(e.target.value)}
					/>
					<p className="text-muted-foreground text-xs">
						Passed as <code>--var-file</code>. Leave empty to use the pack's
						defaults. After saving, use Deploy to run the pack.
					</p>
				</div>
				<div>
					<Button type="button" onClick={save} disabled={update.isPending}>
						<Save className="mr-2 h-4 w-4" /> Save
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
