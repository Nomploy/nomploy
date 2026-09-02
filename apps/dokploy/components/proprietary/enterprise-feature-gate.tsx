/**
 * nomploy — free (Apache-2.0) replacement for the former enterprise feature gate.
 *
 * The upstream components gated UI behind a commercial license. nomploy ships
 * without those paid features:
 *   - `EnterpriseFeatureGate` simply renders its children (the wrapped feature
 *     component decides what to show).
 *   - `EnterpriseFeatureLocked` renders a small, neutral "not included" notice.
 */
import { Info } from "lucide-react";
import type React from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

interface EnterpriseFeatureLockedProps {
	title?: string;
	description?: string;
	ctaLabel?: string;
	ctaHref?: string;
	compact?: boolean;
}

export function EnterpriseFeatureLocked({
	title = "Not included in this build",
	description = "This feature is not part of nomploy.",
	compact = false,
}: EnterpriseFeatureLockedProps) {
	return (
		<Card className="border-dashed bg-transparent">
			<CardHeader className={compact ? "pb-2" : undefined}>
				<div className="flex flex-col items-center gap-3 text-center">
					<div className={`rounded-full bg-muted ${compact ? "p-3" : "p-4"}`}>
						<Info
							className={
								compact
									? "size-6 text-muted-foreground"
									: "size-8 text-muted-foreground"
							}
						/>
					</div>
					<div className="space-y-1">
						<CardTitle className="text-lg">{title}</CardTitle>
						<CardDescription className="max-w-sm mx-auto">
							{description}
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className={compact ? "pt-0" : undefined} />
		</Card>
	);
}

interface EnterpriseFeatureGateProps {
	children: React.ReactNode;
	lockedProps?: Omit<EnterpriseFeatureLockedProps, "compact">;
	fallback?: React.ReactNode;
}

export function EnterpriseFeatureGate({
	children,
}: EnterpriseFeatureGateProps) {
	return <>{children}</>;
}
