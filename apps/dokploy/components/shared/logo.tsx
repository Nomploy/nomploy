import { useId } from "react";
import { cn } from "@/lib/utils";

interface Props {
	className?: string;
	logoUrl?: string;
}

// nomploy brand mark: a rounded teal→sky tile with the white "N" monogram,
// matching the app icon. Self-contained gradient so it renders in brand color
// everywhere (sidebar, login, onboarding) regardless of the surrounding theme.
export const Logo = ({ className = "size-14", logoUrl }: Props) => {
	const gradientId = useId();

	if (logoUrl) {
		return (
			// biome-ignore lint/performance/noImgElement: this is for dynamic logo loading
			<img
				src={logoUrl}
				alt="Organization Logo"
				className={cn(className, "object-contain rounded-sm")}
			/>
		);
	}

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 512 512"
			className={className}
			role="img"
			aria-label="nomploy"
		>
			<defs>
				<linearGradient
					id={gradientId}
					x1="40"
					y1="24"
					x2="472"
					y2="488"
					gradientUnits="userSpaceOnUse"
				>
					<stop offset="0" stopColor="#2DD4BF" />
					<stop offset="0.55" stopColor="#14B8A6" />
					<stop offset="1" stopColor="#0EA5E9" />
				</linearGradient>
			</defs>
			<rect width="512" height="512" rx="116" fill={`url(#${gradientId})`} />
			<path
				fill="#ffffff"
				d="M140 140 H196 V372 H140 Z M316 140 H372 V372 H316 Z M140 140 H240 L372 372 H272 Z"
			/>
		</svg>
	);
};
