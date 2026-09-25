import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { UpdateWebServer } from "./update-webserver";

const DISMISS_KEY = "nomploy-update-dismissed";

/**
 * Passive "update available" banner shown on every dashboard page when a newer
 * Nomploy release is published, so an operator doesn't have to open Settings and
 * click "Check for updates" to notice. Polls settings.checkUpdate on a long
 * interval, reuses the full verify+confirm UpdateWebServer flow, and can be
 * dismissed per version (via localStorage) so it doesn't nag until the next
 * release. Root/admin only, and never on cloud.
 */
export const UpdateBanner = () => {
	const { data: haveRootAccess } = api.user.haveRootAccess.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data } = api.settings.checkUpdate.useQuery(undefined, {
		enabled: isCloud === false && haveRootAccess === true,
		refetchInterval: 6 * 60 * 60 * 1000,
		refetchOnWindowFocus: false,
		staleTime: 6 * 60 * 60 * 1000,
	});

	const [dismissed, setDismissed] = useState<string | null>(null);
	useEffect(() => {
		try {
			setDismissed(localStorage.getItem(DISMISS_KEY));
		} catch {}
	}, []);

	if (isCloud !== false || haveRootAccess !== true) return null;
	if (!data?.updateAvailable) return null;
	const version = data.latestVersion ?? "";
	if (version && dismissed === version) return null;

	const dismiss = () => {
		try {
			if (version) localStorage.setItem(DISMISS_KEY, version);
		} catch {}
		setDismissed(version);
	};

	return (
		<div className="fixed bottom-4 right-4 z-50 flex max-w-[92vw] items-center gap-3 rounded-lg border bg-background p-3 shadow-lg">
			<div className="flex flex-col">
				<span className="text-sm font-medium">Update available</span>
				<span className="text-xs text-muted-foreground">
					Nomploy {version} is ready to install.
				</span>
			</div>
			<div className="w-40">
				<UpdateWebServer />
			</div>
			<Button
				variant="ghost"
				size="icon"
				className="size-7 shrink-0"
				onClick={dismiss}
				title="Dismiss until next release"
			>
				<X className="size-4" />
			</Button>
		</div>
	);
};
