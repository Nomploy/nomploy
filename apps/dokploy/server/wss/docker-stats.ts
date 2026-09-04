import type http from "node:http";
import {
	docker,
	execAsync,
	getHostSystemStats,
	getLastAdvancedStatsFile,
	IS_CLOUD,
	recordAdvancedStats,
	validateRequest,
} from "@nomploy/server";
import {
	ALLOC_ID_LABEL,
	getRunningAllocId,
} from "@nomploy/server/utils/nomad/resolve";
import { WebSocketServer } from "ws";

export const setupDockerStatsMonitoringSocketServer = (
	server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>,
) => {
	const wssTerm = new WebSocketServer({
		noServer: true,
		path: "/listen-docker-stats-monitoring",
	});

	server.on("upgrade", (req, socket, head) => {
		const { pathname } = new URL(req.url || "", `http://${req.headers.host}`);

		if (pathname === "/_next/webpack-hmr") {
			return;
		}
		if (pathname === "/listen-docker-stats-monitoring") {
			wssTerm.handleUpgrade(req, socket, head, function done(ws) {
				wssTerm.emit("connection", ws, req);
			});
		}
	});

	wssTerm.on("connection", async (ws, req) => {
		const url = new URL(req.url || "", `http://${req.headers.host}`);

		if (IS_CLOUD) {
			ws.send("This feature is not available in the cloud version.");
			ws.close();
			return;
		}
		const appName = url.searchParams.get("appName");
		const appType = (url.searchParams.get("appType") || "application") as
			| "application"
			| "docker-compose"
			| "nomad";
		const { user, session } = await validateRequest(req);

		if (!appName) {
			ws.close(4000, "appName no provided");
			return;
		}

		if (!user || !session) {
			ws.close();
			return;
		}
		const intervalId = setInterval(async () => {
			try {
				// Special case: when monitoring "nomploy", get host system stats instead of container stats
				if (appName === "nomploy") {
					const stat = await getHostSystemStats();

					await recordAdvancedStats(stat, appName);
					const data = await getLastAdvancedStatsFile(appName);

					ws.send(
						JSON.stringify({
							data,
						}),
					);
					return;
				}

				// On Nomad, appName is either the job id (application/database) or a
				// specific container name (a compose service picked in the UI). Match
				// the job's running alloc by its alloc-id label; otherwise fall back to
				// the container name. (The legacy Swarm-label branch is kept for
				// non-Nomad deployments.)
				let filter: {
					status: string[];
					label?: string[];
					name?: string[];
				};
				if (appType === "nomad") {
					const allocId = await getRunningAllocId(appName);
					filter = allocId
						? { status: ["running"], label: [`${ALLOC_ID_LABEL}=${allocId}`] }
						: { status: ["running"], name: [appName] };
				} else if (appType === "docker-compose") {
					filter = { status: ["running"], name: [appName] };
				} else {
					filter = {
						status: ["running"],
						label: [`com.docker.swarm.service.name=${appName}`],
					};
				}

				const containers = await docker.listContainers({
					filters: JSON.stringify(filter),
				});

				const container = containers[0];
				if (!container || container?.State !== "running") {
					ws.close(4000, "Container not running");
					return;
				}
				const { stdout, stderr } = await execAsync(
					`docker stats ${container.Id} --no-stream --format \'{"BlockIO":"{{.BlockIO}}","CPUPerc":"{{.CPUPerc}}","Container":"{{.Container}}","ID":"{{.ID}}","MemPerc":"{{.MemPerc}}","MemUsage":"{{.MemUsage}}","Name":"{{.Name}}","NetIO":"{{.NetIO}}"}\'`,
				);
				if (stderr) {
					console.error("Docker stats error:", stderr);
					return;
				}
				const stat = JSON.parse(stdout);

				await recordAdvancedStats(stat, appName);
				const data = await getLastAdvancedStatsFile(appName);

				ws.send(
					JSON.stringify({
						data,
					}),
				);
			} catch (error) {
				// @ts-ignore
				ws.close(4000, `Error: ${error.message}`);
			}
		}, 1300);

		ws.on("close", () => {
			clearInterval(intervalId);
		});
	});
};
