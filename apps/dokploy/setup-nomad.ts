import { exit } from "node:process";
import { setupDirectories } from "@dokploy/server/setup/config-paths";
import { setupNomad } from "@dokploy/server/setup/nomad-setup";

(async () => {
	try {
		setupDirectories();
		await setupNomad();
		console.log("Dokploy (Nomad) setup completed");
		exit(0);
	} catch (e) {
		console.error("Error in Dokploy Nomad setup:", e);
		exit(1);
	}
})();
