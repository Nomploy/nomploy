import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { PenBoxIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

// Providers with a working provisioner (mirrors SUPPORTED_PROVIDERS server-side).
const PROVIDERS = [{ key: "hetzner", name: "Hetzner Cloud" }];

const schema = z.object({
	name: z.string().min(1, "Name is required"),
	provider: z.string().min(1, "Provider is required"),
	// Optional on edit (blank keeps the saved token); required on create is
	// enforced below before submit.
	token: z.string().optional(),
	sshKeyId: z.string().optional(),
});

type Schema = z.infer<typeof schema>;

interface Props {
	cloudProviderId?: string;
}

export const HandleCloudProvider = ({ cloudProviderId }: Props) => {
	const [open, setOpen] = useState(false);
	const utils = api.useUtils();
	const isEdit = !!cloudProviderId;

	const { data: sshKeys } = api.sshKey.all.useQuery();
	const { data: provider } = api.cloudProvider.one.useQuery(
		{ cloudProviderId: cloudProviderId || "" },
		{ enabled: isEdit, refetchOnWindowFocus: false },
	);

	// Separate hooks (not a ternary) so each mutateAsync keeps its own input type.
	const createM = api.cloudProvider.create.useMutation();
	const updateM = api.cloudProvider.update.useMutation();
	const isPending = createM.isPending || updateM.isPending;
	const isError = createM.isError || updateM.isError;
	const error = createM.error || updateM.error;
	const { mutateAsync: testConnection, isPending: isTesting } =
		api.cloudProvider.testConnection.useMutation();

	const form = useForm<Schema>({
		defaultValues: { name: "", provider: "hetzner", token: "", sshKeyId: "" },
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (provider) {
			form.reset({
				name: provider.name,
				provider: provider.provider,
				token: "",
				sshKeyId: provider.sshKeyId ?? "",
			});
		} else if (!isEdit) {
			form.reset({ name: "", provider: "hetzner", token: "", sshKeyId: "" });
		}
	}, [form, provider, isEdit]);

	const onSubmit = async (data: Schema) => {
		if (!isEdit && !data.token) {
			form.setError("token", { message: "Token is required" });
			return;
		}
		const sshKeyId =
			data.sshKeyId && data.sshKeyId !== "none" ? data.sshKeyId : undefined;
		const promise = isEdit
			? updateM.mutateAsync({
					cloudProviderId: cloudProviderId as string,
					name: data.name,
					provider: data.provider,
					sshKeyId,
					...(data.token ? { token: data.token } : {}),
				})
			: createM.mutateAsync({
					name: data.name,
					provider: data.provider,
					token: data.token as string,
					sshKeyId,
				});
		await promise
			.then(async () => {
				toast.success(`Cloud provider ${isEdit ? "updated" : "created"}`);
				await utils.cloudProvider.all.invalidate();
				if (isEdit)
					await utils.cloudProvider.one.invalidate({
						cloudProviderId: cloudProviderId as string,
					});
				setOpen(false);
			})
			.catch((e) =>
				toast.error(`Error ${isEdit ? "updating" : "creating"} the provider`, {
					description: e.message,
				}),
			);
	};

	const handleTest = async () => {
		const provider = form.getValues("provider");
		const token = form.getValues("token");
		if (!provider) {
			toast.error("Select a provider first");
			return;
		}
		if (!token && !isEdit) {
			toast.error("Enter a token to test");
			return;
		}
		await testConnection({
			provider,
			token: token || undefined,
			cloudProviderId: cloudProviderId || undefined,
		})
			.then((r) => toast.success("Connection OK", { description: r.detail }))
			.catch((e) =>
				toast.error("Connection failed", { description: e.message }),
			);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{isEdit ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10"
					>
						<PenBoxIcon className="size-3.5 text-primary group-hover:text-blue-500" />
					</Button>
				) : (
					<Button className="cursor-pointer space-x-3">
						<PlusIcon className="h-4 w-4" />
						Add Cloud Provider
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Update" : "Add"} Cloud Provider</DialogTitle>
					<DialogDescription>
						Register a cloud account once here, then select it on your
						autoscaling groups and one-click Add node — no need to paste the
						token again.
					</DialogDescription>
				</DialogHeader>
				{isError && (
					<AlertBlock type="error" className="w-full">
						{error?.message}
					</AlertBlock>
				)}
				<Form {...form}>
					<form
						id="hook-form-cloud-provider"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Hetzner (prod)" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="provider"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Provider</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select a provider" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{PROVIDERS.map((p) => (
												<SelectItem key={p.key} value={p.key}>
													{p.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="token"
							render={({ field }) => (
								<FormItem>
									<FormLabel>API Token</FormLabel>
									<FormControl>
										<Input
											type="password"
											placeholder={
												isEdit
													? "•••••••• (leave blank to keep)"
													: "Cloud API token"
											}
											{...field}
										/>
									</FormControl>
									<FormDescription>
										{isEdit
											? "A token is already stored; enter a new one only to replace it."
											: "Stored securely and reused by every group that selects this provider."}
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="sshKeyId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Default SSH Key (optional)</FormLabel>
									<Select
										onValueChange={field.onChange}
										value={field.value || ""}
									>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select an SSH key" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{sshKeys?.map((k) => (
												<SelectItem key={k.sshKeyId} value={k.sshKeyId}>
													{k.name}
												</SelectItem>
											))}
											<SelectItem value="none">None</SelectItem>
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
					</form>
					<DialogFooter className="flex w-full flex-row !justify-between gap-4">
						<Button
							type="button"
							variant="secondary"
							isLoading={isTesting}
							onClick={handleTest}
						>
							Test connection
						</Button>
						<Button
							isLoading={isPending}
							form="hook-form-cloud-provider"
							type="submit"
						>
							{isEdit ? "Update" : "Create"}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
