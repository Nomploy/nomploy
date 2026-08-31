import { exit } from "node:process";
import { setupDirectories } from "@nomploy/server/setup/config-paths";
import { setupNomad } from "@nomploy/server/setup/nomad-setup";

(async () => {
	try {
		setupDirectories();
		await setupNomad();
		console.log("Nomploy (Nomad) setup completed");
		exit(0);
	} catch (e) {
		console.error("Error in Nomploy Nomad setup:", e);
		exit(1);
	}
})();
