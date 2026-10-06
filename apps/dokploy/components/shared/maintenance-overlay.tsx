import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const HEALTH_URL = "/api/health";
const POLL_HEALTHY_MS = 15000;
const POLL_DOWN_MS = 2000;

/**
 * Polls the panel's readiness probe (/api/health) and shows a slim, non-blocking
 * banner while the panel is unreachable — e.g. during a self-update (Nomad canary
 * roll) when Traefik briefly has no healthy backend and returns 502/503. The
 * banner auto-clears as soon as the panel answers again. It never traps the user
 * in a full-screen modal; the rest of the UI stays usable while requests retry.
 */
export const MaintenanceOverlay = () => {
	const [down, setDown] = useState(false);

	useEffect(() => {
		if (typeof window === "undefined") return;

		let cancelled = false;

		const check = async () => {
			try {
				const res = await fetch(HEALTH_URL, { cache: "no-store" });
				if (!cancelled) setDown(!res.ok);
			} catch {
				if (!cancelled) setDown(true);
			}
		};

		// Run one check immediately, then poll faster while down so recovery is quick.
		void check();
		const interval = setInterval(check, down ? POLL_DOWN_MS : POLL_HEALTHY_MS);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [down]);

	if (!down) return null;

	return (
		<output
			aria-live="polite"
			className={cn(
				"fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2",
				"border-b border-amber-500/40 bg-amber-500/15 px-4 py-2",
				"text-sm font-medium text-amber-700 backdrop-blur dark:text-amber-300",
			)}
		>
			<Loader2 className="size-4 animate-spin" />
			<span>Panel is updating — reconnecting…</span>
		</output>
	);
};
