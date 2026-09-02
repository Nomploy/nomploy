import type http from "node:http";
import { IS_CLOUD, validateRequest } from "@nomploy/server";
import { spawn } from "node-pty";
import { WebSocketServer } from "ws";

export const setupNomadTerminalWebSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		path: "/nomad-terminal",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);

		if (pathname === "/nomad-terminal") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	wssTerm.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);
		const allocId = url.searchParams.get("allocId");
		const taskName = url.searchParams.get("taskName");
		const activeWay = url.searchParams.get("activeWay") || "/bin/sh";
		const { user, session } = await validateRequest(req);

		if (!allocId || !taskName) {
			ws.close(4000, "allocId and taskName required");
			return;
		}

		// Validate allocId format (UUID)
		if (!/^[a-f0-9-]{36}$/.test(allocId)) {
			ws.close(4000, "Invalid allocation ID format");
			return;
		}

		if (!user || !session) {
			ws.close();
			return;
		}

		try {
			if (IS_CLOUD) {
				ws.send("This feature is not available in the cloud version.");
				ws.close();
				return;
			}

			const ptyProcess = spawn(
				"nomad",
				["alloc", "exec", "-task", taskName, "-i", "-t", allocId, activeWay],
				{},
			);

			ptyProcess.onData((data) => {
				ws.send(data);
			});

			ws.on("close", () => {
				ptyProcess.kill();
			});

			ws.on("message", (message) => {
				try {
					let command: string | Buffer[] | Buffer | ArrayBuffer;
					if (Buffer.isBuffer(message)) {
						command = message.toString("utf8");
					} else {
						command = message;
					}
					ptyProcess.write(command.toString());
				} catch (error) {
					// @ts-ignore
					ws.send(error?.message || "Error");
				}
			});
		} catch (error) {
			// @ts-ignore
			ws.send(error?.message || "Error connecting to allocation");
		}
	});
};
