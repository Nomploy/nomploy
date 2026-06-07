import { Terminal } from "@xterm/xterm";
import React, { useEffect, useRef } from "react";
import { FitAddon } from "xterm-addon-fit";
import "@xterm/xterm/css/xterm.css";
import { AttachAddon } from "@xterm/addon-attach";
import { useTheme } from "next-themes";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Props {
	id: string;
	containerId?: string;
	serverId?: string;
	wsPath?: string;
	taskName?: string;
}

export const DockerTerminal: React.FC<Props> = ({
	id,
	containerId,
	serverId,
	wsPath,
	taskName,
}) => {
	const termRef = useRef(null);
	const [activeWay, setActiveWay] = React.useState<string | undefined>("bash");
	const { resolvedTheme } = useTheme();
	useEffect(() => {
		const container = document.getElementById(id);
		if (container) {
			container.innerHTML = "";
		}
		const term = new Terminal({
			cursorBlink: true,
			lineHeight: 1.4,
			convertEol: true,
			theme: {
				cursor: resolvedTheme === "light" ? "#000000" : "transparent",
				background: "rgba(0, 0, 0, 0)",
				foreground: "currentColor",
			},
		});
		const addonFit = new FitAddon();
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

		const wsUrl = wsPath === "/nomad-terminal"
			? `${protocol}//${window.location.host}/nomad-terminal?allocId=${containerId}&taskName=${taskName}&activeWay=${activeWay}`
			: `${protocol}//${window.location.host}/docker-container-terminal?containerId=${containerId}&activeWay=${activeWay}${serverId ? `&serverId=${serverId}` : ""}`;

		const ws = new WebSocket(wsUrl);

		// @ts-ignore
		term.open(termRef.current);
		// @ts-ignore
		term.loadAddon(addonFit);
		addonFit.fit();

		ws.onopen = () => {
			const addonAttach = new AttachAddon(ws);
			term.loadAddon(addonAttach);
		};

		return () => {
			ws.readyState === WebSocket.OPEN && ws.close();
		};
	}, [containerId, activeWay, id]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2  mt-4">
				<span>
					Select way to connect to <b>{containerId}</b>
				</span>
				<Tabs value={activeWay} onValueChange={setActiveWay}>
					<TabsList>
						<TabsTrigger value="bash">Bash</TabsTrigger>
						<TabsTrigger value="sh">/bin/sh</TabsTrigger>
					</TabsList>
				</Tabs>
			</div>
			<div className="w-full h-full rounded-lg p-2 bg-transparent border">
				<div id={id} ref={termRef} />
			</div>
		</div>
	);
};
