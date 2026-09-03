import {
	generateDatabaseNomadJob,
	type NomadDatabaseInput,
} from "@nomploy/server/utils/builders/nomad-database";
import { describe, expect, it } from "vitest";

const pg: NomadDatabaseInput = {
	appName: "myproj-pg-abc123",
	image: "postgres:16",
	containerPort: 5432,
	externalPort: 5433,
	dataPath: "/var/lib/postgresql/data",
	env: 'POSTGRES_DB="app"\nPOSTGRES_USER="app"\nPOSTGRES_PASSWORD="secret"',
	projectEnv: null,
	environmentEnv: null,
	cpuLimit: "500000000", // 0.5 core
	memoryLimit: "268435456", // 256 MB
	targetNodeName: "nomploy",
	mounts: [],
};

describe("nomad database builder — DB → HCL", () => {
	it("builds a stateful, node-pinned Postgres job", () => {
		const hcl = generateDatabaseNomadJob(pg);

		expect(hcl).toContain('job "myproj-pg-abc123"');
		expect(hcl).toContain("count = 1");
		// pinned to its node (data lives in a node-local volume)
		expect(hcl).toContain("node.unique.name");
		expect(hcl).toContain('value     = "nomploy"');
		// persistent data volume for the engine's data dir
		expect(hcl).toContain('"myproj-pg-abc123-data:/var/lib/postgresql/data"');
		// engine image + static standard port so <appName>:5432 works cluster-wide
		expect(hcl).toContain('image   = "postgres:16"');
		expect(hcl).toContain("static = 5432");
		// optional fixed external port
		expect(hcl).toContain("static = 5433");
		// discoverable in Consul by its appName + cluster DNS for the container
		expect(hcl).toContain('name     = "myproj-pg-abc123"');
		expect(hcl).toContain('provider = "consul"');
		expect(hcl).toContain('searches = ["service.consul"]');
		// env + resources (0.5 core -> 500 MHz, 256 MB)
		expect(hcl).toContain('POSTGRES_PASSWORD = "secret"');
		expect(hcl).toContain("cpu    = 500");
		expect(hcl).toContain("memory = 256");
	});

	it("defaults resources and omits the external port when unset", () => {
		const hcl = generateDatabaseNomadJob({
			...pg,
			externalPort: null,
			cpuLimit: null,
			memoryLimit: null,
		});
		expect(hcl).toContain("cpu    = 500");
		expect(hcl).toContain("memory = 512");
		// primary static engine port is always present; the extra external one is not
		expect(hcl).toContain("static = 5432");
		expect(hcl).not.toContain('"external"');
	});
});
