import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { NomadSettings } from "./nomad-settings";

interface Props {
	serverId: string;
}

export const NomadSettingsModal = ({ serverId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DropdownMenuItem
				className="w-full cursor-pointer"
				onSelect={(e) => {
					e.preventDefault();
					setIsOpen(true);
				}}
			>
				Nomad
			</DropdownMenuItem>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Nomad</DialogTitle>
					<DialogDescription>
						Configure this server's Nomad connection, or bootstrap the Nomad
						stack (Docker, Consul, Nomad, CNI) on it.
					</DialogDescription>
				</DialogHeader>
				<NomadSettings serverId={serverId} />
			</DialogContent>
		</Dialog>
	);
};
