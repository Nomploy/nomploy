import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

interface Props {
	applicationId: string;
}

type FileEntry = { mountPath: string; content: string };

const sameFiles = (a: FileEntry[], b: FileEntry[]): boolean =>
	a.length === b.length &&
	a.every(
		(f, i) => f.mountPath === b[i]?.mountPath && f.content === b[i]?.content,
	);

/**
 * Config files mounted into the container from a Nomad Variable. Each entry is a
 * target path + file content; the content is stored in the job's Nomad Variable
 * (never in the job spec) and rendered to that path inside the container as a
 * real file (unlike Runtime Secrets, which are injected as env). Editing an
 * existing file rolls the task on its own; the FIRST file added needs a redeploy
 * to attach the template.
 */
export const ShowNomadConfigFiles = ({ applicationId }: Props) => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canWrite = permissions?.envVars.write ?? false;

	const { data, refetch } = api.nomad.getAppConfigFiles.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);
	const { mutateAsync, isPending } = api.nomad.setAppConfigFiles.useMutation();

	const [files, setFiles] = useState<FileEntry[]>([]);
	const loaded = data?.files ?? [];
	const hasChanges = !sameFiles(files, loaded);

	useEffect(() => {
		if (data) setFiles(data.files);
	}, [data]);

	const update = (i: number, patch: Partial<FileEntry>) =>
		setFiles((prev) =>
			prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)),
		);
	const addFile = () =>
		setFiles((prev) => [...prev, { mountPath: "", content: "" }]);
	const removeFile = (i: number) =>
		setFiles((prev) => prev.filter((_, idx) => idx !== i));

	const onSubmit = async () => {
		const cleaned = files.filter((f) => f.mountPath.trim());
		const wasEnabled = (loaded.length ?? 0) > 0;
		try {
			const res = await mutateAsync({ applicationId, files: cleaned });
			await refetch();
			if (res.enabled && !wasEnabled) {
				toast.success("Config files saved — redeploy the app to mount them");
			} else if (!res.enabled) {
				toast.success("Config files cleared");
			} else {
				toast.success("Config files updated");
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Error saving config files",
			);
		}
	};

	const handleCancel = () => setFiles(loaded);

	return (
		<Card className="flex flex-col gap-4 bg-background px-6 pb-6 pt-6">
			<div className="flex flex-col gap-1">
				<span className="font-medium text-sm">Config Files</span>
				<span className="text-muted-foreground text-sm">
					Stored in a Nomad Variable and mounted into the container as a file at
					the given path — the content never appears in the job spec.
					{hasChanges && (
						<span className="ml-2 text-yellow-500">
							(You have unsaved changes)
						</span>
					)}
				</span>
			</div>

			{files.length === 0 && (
				<span className="text-muted-foreground text-sm">
					No config files. Add one to mount a file (e.g. an nginx.conf or a
					settings.yaml) into the container.
				</span>
			)}

			{files.map((f, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
				<div key={i} className="flex flex-col gap-2 rounded-lg border p-4">
					<div className="flex items-end gap-2">
						<div className="flex flex-1 flex-col gap-1">
							<Label htmlFor={`cfg-path-${i}`}>Mount path</Label>
							<Input
								id={`cfg-path-${i}`}
								placeholder="/etc/nginx/nginx.conf"
								value={f.mountPath}
								disabled={!canWrite}
								onChange={(e) => update(i, { mountPath: e.target.value })}
							/>
						</div>
						{canWrite && (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								onClick={() => removeFile(i)}
							>
								<Trash2 className="h-4 w-4 text-destructive" />
							</Button>
						)}
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor={`cfg-content-${i}`}>Content</Label>
						<Textarea
							id={`cfg-content-${i}`}
							className="font-mono text-xs"
							rows={8}
							placeholder="file contents…"
							value={f.content}
							disabled={!canWrite}
							onChange={(e) => update(i, { content: e.target.value })}
						/>
					</div>
				</div>
			))}

			{canWrite && (
				<Button
					type="button"
					variant="outline"
					className="w-fit"
					onClick={addFile}
				>
					<Plus className="mr-2 h-4 w-4" />
					Add config file
				</Button>
			)}

			{data && loaded.length === 0 && (
				<AlertBlock type="info">
					The first config file needs a redeploy to be mounted. After that,
					content changes roll the task automatically.
				</AlertBlock>
			)}

			{canWrite && (
				<div className="flex flex-row justify-end gap-2">
					{hasChanges && (
						<Button type="button" variant="outline" onClick={handleCancel}>
							Cancel
						</Button>
					)}
					<Button
						isLoading={isPending}
						className="w-fit"
						type="button"
						onClick={onSubmit}
						disabled={!hasChanges}
					>
						Save
					</Button>
				</div>
			)}
		</Card>
	);
};
