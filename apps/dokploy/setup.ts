import { exec } from "node:child_process";
import { exit } from "node:process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

import { setupDirectories } from "@nomploy/server/setup/config-paths";
import { initializePostgres } from "@nomploy/server/setup/postgres-setup";
import { initializeRedis } from "@nomploy/server/setup/redis-setup";
import {
	initializeNetwork,
	initializeSwarm,
} from "@nomploy/server/setup/setup";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	initializeStandaloneTraefik,
	TRAEFIK_VERSION,
} from "@nomploy/server/setup/traefik-setup";

(async () => {
	try {
		setupDirectories();
		createDefaultMiddlewares();
		await initializeSwarm();
		await initializeNetwork();
		createDefaultTraefikConfig();
		createDefaultServerTraefikConfig();
		await execAsync(`docker pull traefik:v${TRAEFIK_VERSION}`);
		await initializeStandaloneTraefik();
		await initializeRedis();
		await initializePostgres();
		console.log("Nomploy setup completed");
		exit(0);
	} catch (e) {
		console.error("Error in nomploy setup", e);
	}
})();
