import { Fingerprint, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

type Passkey = {
	id: string;
	name?: string | null;
	createdAt?: string | Date | null;
	deviceType?: string | null;
};

/**
 * Manage WebAuthn passkeys for the current user (register / list / delete). Uses
 * the better-auth passkey plugin; registration triggers the browser's WebAuthn
 * prompt (Touch ID / security key / platform authenticator).
 */
export const ManagePasskeys = () => {
	const [passkeys, setPasskeys] = useState<Passkey[]>([]);
	const [loading, setLoading] = useState(true);
	const [adding, setAdding] = useState(false);
	const [name, setName] = useState("");

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			const res = await authClient.passkey.listUserPasskeys();
			setPasskeys((res?.data as Passkey[]) ?? []);
		} catch {
			// leave the list empty; the card still renders
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const add = async () => {
		setAdding(true);
		try {
			const res = await authClient.passkey.addPasskey({
				name: name.trim() || undefined,
			});
			if (res && "error" in res && res.error) {
				throw new Error(res.error.message || "Could not add passkey");
			}
			toast.success("Passkey added");
			setName("");
			await refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Could not add passkey");
		} finally {
			setAdding(false);
		}
	};

	const remove = async (id: string) => {
		try {
			await authClient.passkey.deletePasskey({ id });
			toast.success("Passkey removed");
			await refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Could not remove passkey");
		}
	};

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<CardHeader>
					<CardTitle className="text-xl flex flex-row gap-2 items-center">
						<KeyRound className="size-5 text-muted-foreground" />
						Passkeys
					</CardTitle>
					<CardDescription>
						Sign in with Touch ID, a security key, or your device instead of a
						password. You can add more than one.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
						<div className="flex-1">
							<Input
								placeholder="Passkey name (e.g. MacBook Touch ID)"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
						<Button onClick={add} disabled={adding}>
							{adding ? (
								<Loader2 className="mr-2 size-4 animate-spin" />
							) : (
								<Plus className="mr-2 size-4" />
							)}
							Add passkey
						</Button>
					</div>

					{loading ? (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" /> Loading…
						</p>
					) : passkeys.length === 0 ? (
						<p className="text-muted-foreground text-sm">No passkeys yet.</p>
					) : (
						<div className="flex flex-col divide-y rounded-lg border">
							{passkeys.map((p) => (
								<div
									key={p.id}
									className="flex items-center justify-between gap-3 p-3"
								>
									<div className="flex items-center gap-2 min-w-0">
										<Fingerprint className="size-4 text-muted-foreground shrink-0" />
										<div className="min-w-0">
											<p className="truncate font-medium text-sm">
												{p.name || "Passkey"}
											</p>
											{p.createdAt && (
												<p className="text-muted-foreground text-xs">
													Added {new Date(p.createdAt).toLocaleDateString()}
												</p>
											)}
										</div>
									</div>
									<DialogAction
										title="Remove passkey?"
										description="You won't be able to sign in with this passkey anymore."
										onClick={() => remove(p.id)}
									>
										<Button variant="ghost" size="sm">
											<Trash2 className="size-3.5 text-destructive" />
										</Button>
									</DialogAction>
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
};
