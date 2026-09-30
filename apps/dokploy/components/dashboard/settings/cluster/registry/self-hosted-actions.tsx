import { Copy, ExternalLink, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";

const copy = (v: string) => {
	navigator.clipboard?.writeText(v);
	toast.success("Copied");
};

const Row = ({ label, value }: { label: string; value: string }) => (
	<div className="space-y-1">
		<span className="text-muted-foreground text-xs">{label}</span>
		<div className="flex gap-2">
			<Input readOnly value={value} className="font-mono text-xs" />
			<Button variant="outline" size="icon" onClick={() => copy(value)}>
				<Copy className="size-3.5" />
			</Button>
		</div>
	</div>
);

/** Per-row actions for a self-hosted registry: open the zot UI + view credentials. */
export const SelfHostedActions = ({
	registryId,
	url,
}: {
	registryId: string;
	url: string;
}) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const { data: creds } = api.registry.selfHostedCredentials.useQuery(
		{ registryId },
		{ enabled: open },
	);

	// zot's UI uses htpasswd Basic auth. Browsers block `user:pass@` in the URL, so
	// open the UI and copy the password to the clipboard — the user pastes it at
	// zot's login prompt. Open the tab synchronously (in the gesture) to dodge the
	// popup blocker, then fetch + copy.
	const openUI = async () => {
		window.open(`https://${url}`, "_blank", "noopener,noreferrer");
		try {
			const c = await utils.registry.selfHostedCredentials.fetch({
				registryId,
			});
			await navigator.clipboard?.writeText(c.password);
			toast.success(
				`Opening zot — sign in as "${c.username}"; password copied to clipboard.`,
			);
		} catch {
			toast.message("Open the key icon for the login credentials.");
		}
	};

	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				onClick={openUI}
				title="Open registry UI (signed in)"
			>
				<ExternalLink className="size-4 text-muted-foreground" />
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogTrigger asChild>
					<Button variant="ghost" size="icon" title="Registry credentials">
						<KeyRound className="size-4 text-muted-foreground" />
					</Button>
				</DialogTrigger>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Registry credentials</DialogTitle>
						<DialogDescription>
							Sign into the zot UI or authenticate Docker with these. Apps
							deployed through this registry log in automatically.
						</DialogDescription>
					</DialogHeader>
					{creds ? (
						<div className="flex flex-col gap-3">
							<Row label="Registry" value={creds.url} />
							<Row label="Username" value={creds.username} />
							<Row label="Password" value={creds.password} />
							<Row
								label="Docker login"
								value={`echo '${creds.password}' | docker login ${creds.url} -u ${creds.username} --password-stdin`}
							/>
						</div>
					) : (
						<p className="text-muted-foreground text-sm">Loading…</p>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
};
