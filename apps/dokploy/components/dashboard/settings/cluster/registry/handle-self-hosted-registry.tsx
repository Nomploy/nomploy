import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { HardDrive, Info, ServerIcon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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

const Schema = z.object({
	registryName: z.string().min(1, { message: "Name is required" }),
	domain: z
		.string()
		.regex(
			/^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?(:\d{1,5})?$/,
			"Enter a valid hostname (e.g. registry.example.com)",
		),
	destinationId: z.string().min(1, { message: "Pick an S3 destination" }),
	imagePrefix: z.string().optional(),
});
type Values = z.infer<typeof Schema>;

/**
 * Provision nomploy's OWN registry: a self-hosted, S3-backed zot instance exposed
 * on a domain with TLS. Distinct from the "external registry" dialog (which stores
 * credentials for someone else's registry) — this one stands up the registry.
 */
export const HandleSelfHostedRegistry = () => {
	const utils = api.useUtils();
	const [isOpen, setIsOpen] = useState(false);
	const { data: destinations } = api.destination.all.useQuery();
	const { mutateAsync, isError, error } =
		api.registry.createSelfHosted.useMutation();

	const form = useForm<Values>({
		defaultValues: {
			registryName: "nomploy-registry",
			domain: "",
			destinationId: "",
			imagePrefix: "",
		},
		resolver: zodResolver(Schema),
	});

	const onSubmit = async (data: Values) => {
		await mutateAsync({
			registryName: data.registryName,
			domain: data.domain,
			destinationId: data.destinationId,
			imagePrefix: data.imagePrefix?.trim() ? data.imagePrefix.trim() : null,
		})
			.then(async () => {
				await utils.registry.all.invalidate();
				toast.success(
					"Registry provisioning — zot is starting; TLS may take a minute",
				);
				setIsOpen(false);
			})
			.catch(() => toast.error("Error provisioning the registry"));
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				<Button variant="secondary" className="cursor-pointer space-x-3">
					<HardDrive className="h-4 w-4" />
					Self-hosted (zot + S3)
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Self-hosted registry (zot + S3)</DialogTitle>
					<DialogDescription>
						Stand up nomploy's own container registry — an S3-backed zot
						instance exposed on a domain with TLS. Needed to run apps you build
						from source across the cluster.
					</DialogDescription>
				</DialogHeader>

				{isError && (
					<div className="rounded-lg bg-red-50 p-2 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">
						{error?.message}
					</div>
				)}

				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="registryName"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="nomploy-registry" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="domain"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Domain</FormLabel>
									<FormDescription>
										Public TLS endpoint for the registry. DNS is pointed at the
										LoadBalancer automatically (grey-cloud) and a certificate is
										issued via DNS-01.
									</FormDescription>
									<FormControl>
										<Input placeholder="registry.example.com" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="destinationId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>S3 storage</FormLabel>
									<FormDescription>
										The S3-compatible bucket that stores the images (blobs live
										under a <code>zot/</code> prefix). Reuses an S3 Destination.
									</FormDescription>
									<Select
										onValueChange={field.onChange}
										defaultValue={field.value}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select an S3 destination" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{destinations?.map((d) => (
												<SelectItem
													key={d.destinationId}
													value={d.destinationId}
												>
													<span className="flex items-center gap-2">
														<ServerIcon className="size-3.5 text-muted-foreground" />
														{d.name}
														<span className="text-muted-foreground text-xs">
															{d.bucket}
														</span>
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									{destinations?.length === 0 && (
										<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
											<Info className="size-3.5" />
											No S3 destinations yet — create one under Settings → S3
											Destinations first.
										</p>
									)}
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="imagePrefix"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Image prefix (optional)</FormLabel>
									<FormControl>
										<Input
											placeholder="defaults to the registry user"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<DialogFooter>
							<Button
								isLoading={form.formState.isSubmitting}
								type="submit"
								disabled={!destinations || destinations.length === 0}
							>
								Provision
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
