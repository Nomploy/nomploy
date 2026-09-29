import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

/**
 * Detects that the panel rolled to a new version WHILE this tab has been open —
 * i.e. the loaded client JS is now stale against the running server, the common
 * cause of "the UI looks a version behind" right after a release (a cached bundle
 * talking to the new server). Compares the running server version
 * (settings.getNomployVersion) captured at mount to later polls; on a change it
 * prompts a reload to pick up the new bundle.
 *
 * NOT the same as UpdateBanner, which offers to INSTALL a newer release — this
 * only tells the current viewer to refresh their page.
 */
export const StaleBundleBanner = () => {
	const { data: version } = api.settings.getNomployVersion.useQuery(undefined, {
		// Cheap query; poll so an open tab notices a roll within ~a minute, and on
		// refocus (the user comes back to a tab that was open during the roll).
		refetchInterval: 60_000,
		refetchOnWindowFocus: true,
	});
	const loadedVersion = useRef<string | null>(null);
	const [newVersion, setNewVersion] = useState<string | null>(null);

	useEffect(() => {
		if (!version) return;
		if (loadedVersion.current === null) {
			loadedVersion.current = version;
			return;
		}
		if (version !== loadedVersion.current) setNewVersion(version);
	}, [version]);

	if (!newVersion) return null;

	return (
		<div className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-3 border-b bg-primary/10 px-4 py-2 text-center text-sm backdrop-blur">
			<RefreshCw className="size-4 shrink-0" />
			<span>
				The panel updated to <b>{newVersion}</b> — reload to get the latest
				interface.
			</span>
			<Button
				size="sm"
				className="h-7 shrink-0"
				onClick={() => window.location.reload()}
			>
				Reload
			</Button>
		</div>
	);
};
