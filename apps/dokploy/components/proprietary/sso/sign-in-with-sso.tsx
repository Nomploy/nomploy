/**
 * nomploy — SSO login is an enterprise feature that is not shipped. When a
 * fallback (the email / password form) is provided we render it as-is; when SSO
 * would be enforced there is nothing to show.
 */
import type React from "react";

interface SignInWithSSOProps {
	children?: React.ReactNode;
	enforce?: boolean;
}

export function SignInWithSSO({ children }: SignInWithSSOProps) {
	return children ? <>{children}</> : null;
}
