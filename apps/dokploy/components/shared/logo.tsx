import { cn } from "@/lib/utils";

interface Props {
	className?: string;
	logoUrl?: string;
}

// Placeholder nomploy monogram. Replace with a real brand mark before launch.
export const Logo = ({ className = "size-14", logoUrl }: Props) => {
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
			viewBox="0 0 120 120"
			className={className}
			role="img"
			aria-label="nomploy"
		>
			<path
				className="fill-primary"
				d="M20 100 L20 20 L38 20 L82 74 L82 20 L100 20 L100 100 L82 100 L38 46 L38 100 Z"
			/>
		</svg>
	);
};
