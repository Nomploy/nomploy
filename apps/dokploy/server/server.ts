import http from "node:http";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	IS_CLOUD,
	initCancelDeployments,
	initCronJobs,
	initEnterpriseBackupCronJobs,
	initSchedules,
	initVolumeBackupsCronJobs,
	sendNomployRestartNotifications,
	setupDirectories,
} from "@nomploy/server";
import { waitForDatabase } from "@nomploy/server/db";
import { config } from "dotenv";
import next from "next";
import { NOMPLOY_VERSION } from "./nomploy-version";
import { setupDockerContainerLogsWebSocketServer } from "./wss/docker-container-logs";
import { setupDockerContainerTerminalWebSocketServer } from "./wss/docker-container-terminal";
import { setupDockerStatsMonitoringSocketServer } from "./wss/docker-stats";
import { setupDrawerLogsWebSocketServer } from "./wss/drawer-logs";
import { setupDeploymentLogsWebSocketServer } from "./wss/listen-deployment";
import { setupNomadTerminalWebSocketServer } from "./wss/nomad-terminal";
import { setupTerminalWebSocketServer } from "./wss/terminal";

config({ path: ".env" });
// Prefer NOMAD_PORT_http — Nomad auto-injects it when the panel job declares a
// dynamic `port "http"` (zero-downtime/canary mode), so two panels can bind
// different ports during a rolling swap. Falls back to PORT (host-static mode) /
// 3000. Reading the injected var directly avoids the unreliable ${NOMAD_PORT_http}
// env-stanza interpolation in host networking.
const PORT = Number.parseInt(
	process.env.NOMAD_PORT_http || process.env.PORT || "3000",
	10,
);
const HOST = process.env.HOST || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";

// Initialize critical directories and Traefik config BEFORE Next.js starts
// This prevents race conditions with the install script
if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
	setupDirectories();
	createDefaultTraefikConfig();
	createDefaultServerTraefikConfig();
	console.log("✅ initialization complete");
}

const app = next({ dev, turbopack: process.env.TURBOPACK === "1" });
const handle = app.getRequestHandler();
void (async () => {
	// Wait out a transient DB blip BEFORE Next.js boots — app.prepare() triggers
	// better-auth DB calls, and an unhandled CONNECT_TIMEOUT there exits the
	// process (a rolling deploy or raft blip would otherwise fail the new alloc).
	if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
		await waitForDatabase();
	}
	try {
		await app.prepare();
		console.log("Running NomployVersion: ", NOMPLOY_VERSION);
		const server = http.createServer((req, res) => {
			handle(req, res);
		});

		// WEBSOCKET
		setupDrawerLogsWebSocketServer(server);
		setupDeploymentLogsWebSocketServer(server);
		setupDockerContainerLogsWebSocketServer(server);
		setupDockerContainerTerminalWebSocketServer(server);
		setupNomadTerminalWebSocketServer(server);
		setupTerminalWebSocketServer(server);
		if (!IS_CLOUD) {
			setupDockerStatsMonitoringSocketServer(server);
		}

		server.listen(PORT, HOST);
		console.log(`Server Started on: http://${HOST}:${PORT}`);
		if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
			createDefaultMiddlewares();
			// No docker overlay network on Nomad — services use the WireGuard overlay
			// + Consul; creating an "overlay" network here needs Swarm and 403s.

			// Background SINGLETONS (cron backups/schedules, the autoscaler, cluster
			// health monitor, scheduled scaling) must run on exactly ONE panel. Gate
			// them behind a Postgres advisory-lock leader election so a rolling/canary
			// update — where a new panel briefly overlaps the old — never double-runs
			// them. With count=1 the lock is always free, so this is a no-op today;
			// the non-leader serves HTTP and inherits the loops when the old panel
			// exits (releasing the lock). HTTP serving + the deployment worker below
			// run on every instance regardless.
			const { runAsLeader } = await import("@nomploy/server/setup/leader");
			await runAsLeader(
				async () => {
					console.log("✅ Control-plane leader — starting background loops");
					await initCronJobs();
					await initSchedules();
					await initCancelDeployments();
					await initVolumeBackupsCronJobs();
					await sendNomployRestartNotifications();
					// Phase C: cluster autoscaler loop (reconciles orgs that enabled it).
					const { startAutoscalerLoop } = await import(
						"@nomploy/server/setup/autoscale/reconcile"
					);
					startAutoscalerLoop(60);
					// Scheduled scaling actions (cron → set a group's desired count).
					const { initAutoscalingSchedules } = await import(
						"@nomploy/server/setup/autoscale/schedule"
					);
					await initAutoscalingSchedules();
					// Cluster health monitor (node down / raft leader → cluster alerts).
					const { startClusterHealthLoop } = await import(
						"@nomploy/server/setup/monitoring/cluster-health"
					);
					startClusterHealthLoop(60);
				},
				{
					onWait: () =>
						console.log(
							"⏳ Another panel holds control-plane leadership; serving HTTP only (will take over the loops if it exits)",
						),
				},
			);
		}
		await initEnterpriseBackupCronJobs();

		if (!IS_CLOUD) {
			console.log("Starting Deployment Worker");
			const { deploymentWorker } = await import("./queues/deployments-queue");
			await deploymentWorker.run();
		}
	} catch (e) {
		console.error("Main Server Error", e);
	}
})();
