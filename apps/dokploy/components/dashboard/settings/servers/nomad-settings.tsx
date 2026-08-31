import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
import { api } from "@/utils/api";

const nomadSchema = z.object({
	nomadAddress: z.string().url("Must be a valid URL").or(z.literal("")),
	nomadToken: z.string().optional(),
	nomadNamespace: z.string(),
	registryUrl: z.string().optional(),
});

type NomadFormValues = z.infer<typeof nomadSchema>;

interface Props {
	serverId: string;
}

export const NomadSettings = ({ serverId }: Props) => {
	const { data: server, refetch } = api.server.one.useQuery(
		{ serverId },
		{ enabled: !!serverId },
	);

	const { mutateAsync, isPending } = api.server.update.useMutation();

	const form = useForm<NomadFormValues>({
		resolver: zodResolver(nomadSchema),
		values: {
			nomadAddress: server?.nomadAddress || "",
			nomadToken: server?.nomadToken || "",
			nomadNamespace: server?.nomadNamespace || "default",
			registryUrl: server?.registryUrl || "",
		},
	});

	const onSubmit = async (data: NomadFormValues) => {
		if (!server) return;
		try {
			await mutateAsync({
				...server,
				...data,
				serverId,
			});
			toast.success("Nomad settings saved");
			refetch();
		} catch {
			toast.error("Failed to save Nomad settings");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Nomad Configuration</CardTitle>
				<CardDescription>
					Configure Nomad cluster connection for deploying services.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="nomadAddress"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Nomad Address</FormLabel>
									<FormControl>
										<Input
											placeholder="http://nomad.example.com:4646"
											{...field}
										/>
									</FormControl>
									<FormDescription>
										The HTTP address of your Nomad cluster.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="nomadToken"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Nomad Token</FormLabel>
									<FormControl>
										<Input
											type="password"
											placeholder="ACL token (optional)"
											{...field}
										/>
									</FormControl>
									<FormDescription>
										ACL token for authenticating with Nomad.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="nomadNamespace"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Namespace</FormLabel>
									<FormControl>
										<Input placeholder="default" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="registryUrl"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Docker Registry URL</FormLabel>
									<FormControl>
										<Input placeholder="registry.example.com" {...field} />
									</FormControl>
									<FormDescription>
										Registry where images are pushed for Nomad to pull.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<Button type="submit" disabled={isPending}>
							{isPending ? "Saving..." : "Save"}
						</Button>
					</form>
				</Form>
			</CardContent>
		</Card>
	);
};
