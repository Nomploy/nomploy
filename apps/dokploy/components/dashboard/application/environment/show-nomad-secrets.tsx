import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Form } from "@/components/ui/form";
import { Secrets } from "@/components/ui/secrets";
import { api } from "@/utils/api";

const schema = z.object({ secrets: z.string() });
type Schema = z.infer<typeof schema>;

// Runtime secrets live in a Nomad Variable (nomad/jobs/<appName>), injected into
// the container as env via a template block — the values never appear in the job
// spec. One KEY=VALUE per line, same editor as the env card.
const parseSecrets = (text: string): Record<string, string> => {
	const items: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (key) items[key] = line.slice(eq + 1);
	}
	return items;
};

const serializeSecrets = (items: Record<string, string>): string =>
	Object.entries(items)
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");

interface Props {
	applicationId: string;
}

export const ShowNomadSecrets = ({ applicationId }: Props) => {
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canWrite = permissions?.envVars.write ?? false;

	const { data, refetch } = api.nomad.getAppSecrets.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);
	const { mutateAsync, isPending } = api.nomad.setAppSecrets.useMutation();

	const form = useForm<Schema>({
		defaultValues: { secrets: "" },
		resolver: zodResolver(schema),
	});

	const current = form.watch("secrets");
	const loaded = data ? serializeSecrets(data.items) : "";
	const hasChanges = current !== loaded;

	useEffect(() => {
		if (data) form.reset({ secrets: serializeSecrets(data.items) });
	}, [data, form]);

	const onSubmit = async (formData: Schema) => {
		const items = parseSecrets(formData.secrets);
		const wasEnabled = data?.enabled ?? false;
		try {
			const res = await mutateAsync({ applicationId, items });
			await refetch();
			// The template that reads the variable is only added to the job on
			// deploy. Once present, Nomad rolls the task on a secret change on its
			// own — so only the FIRST enable needs a redeploy.
			if (res.enabled && !wasEnabled) {
				toast.success("Secrets saved — redeploy the app to activate them");
			} else if (!res.enabled) {
				toast.success("Secrets cleared");
			} else {
				toast.success("Secrets updated");
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Error saving secrets");
		}
	};

	const handleCancel = () => form.reset({ secrets: loaded });

	return (
		<Card className="bg-background px-6 pb-6">
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex w-full flex-col gap-4"
				>
					<Secrets
						name="secrets"
						title="Runtime Secrets"
						description={
							<span>
								Stored in a Nomad Variable and injected into the container as
								environment variables at runtime — the values never appear in
								the job spec (unlike Environment Settings above).
								{hasChanges && (
									<span className="text-yellow-500 ml-2">
										(You have unsaved changes)
									</span>
								)}
							</span>
						}
						placeholder={["DB_PASSWORD=s3cr3t", "API_KEY=xyz"].join("\n")}
					/>
					{data && !data.enabled && Object.keys(data.items).length === 0 && (
						<AlertBlock type="info">
							The first time you add secrets you must redeploy the app to
							activate them. After that, changes roll the task automatically.
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
								type="submit"
								disabled={!hasChanges}
							>
								Save
							</Button>
						</div>
					)}
				</form>
			</Form>
		</Card>
	);
};
