import { getBuildNomadCommand } from "@nomploy/server/utils/builders/nomad";
import { describe, expect, it } from "vitest";

// A realistic compose: a web service (ports, env with a ${VAR}, healthcheck,
// replicas, resource limits, autoscaling) + a worker. One Dokploy domain targets
// the web service. We assert the generated Nomad HCL job reflects all of it.
const composeFile = `
services:
  web:
    image: myregistry/web:latest
    ports:
      - "3000"
    environment:
      NODE_ENV: production
      API_URL: \${API_URL}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 15s
      timeout: 5s
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: "0.5"
          memory: 512M
    x-nomad-scaling:
      min: 2
      max: 6
      cpu_target: 70
  worker:
    image: myregistry/worker:latest
    environment:
      QUEUE: default
`;

const compose = {
	appName: "myapp",
	serverId: null,
	composeFile,
	// Service env resolves a project-level variable via the ${{project.X}} syntax;
	// the resulting API_URL is then interpolated into the compose YAML's ${API_URL}.
	env: "API_URL=${{project.API_BASE}}",
	environment: {
		project: { env: "API_BASE=https://api.example.com" },
		env: null,
	},
	mounts: [],
	domains: [
		{
			serviceName: "web",
			port: 3000,
			host: "app.example.com",
			https: true,
			path: "/",
			uniqueConfigKey: 1,
			customCertResolver: "letsencrypt",
		},
	],
	// biome-ignore lint/suspicious/noExplicitAny: test mock of NomadComposeNested
} as any;

describe("nomad builder — compose → HCL (live)", () => {
	it("translates a compose into a Nomad job spec", async () => {
		const cmd = await getBuildNomadCommand(compose);

		// getBuildNomadCommand embeds the HCL as base64 in the deploy script.
		const match = cmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/);
		expect(match).not.toBeNull();
		const hcl = Buffer.from(match?.[1] ?? "", "base64").toString("utf8");

		// Print it so the translation is visible when running the test.
		console.log("\n===== generated Nomad HCL =====\n" + hcl + "\n===============================\n");

		// Job + both task groups
		expect(hcl).toContain('job "myapp"');
		expect(hcl).toContain('group "web"');
		expect(hcl).toContain('group "worker"');

		// Replicas, image, container port
		expect(hcl).toContain("count = 2");

		// Multi-replica service spreads across distinct nodes (uses whole cluster)
		expect(hcl).toContain("spread {");
		expect(hcl).toContain("node.unique.id");
		expect(hcl).toContain('image = "myregistry/web:latest"');
		expect(hcl).toContain("to = 3000");

		// ${API_URL} resolved from project env; static env kept
		expect(hcl).toContain("https://api.example.com");
		expect(hcl).toContain('NODE_ENV = "production"');

		// Resource limits translated (0.5 CPU -> 500 MHz, 512M -> 512 MB)
		expect(hcl).toContain("cpu    = 500");
		expect(hcl).toContain("memory = 512");

		// Autoscaling block from x-nomad-scaling
		expect(hcl).toContain("scaling {");
		expect(hcl).toContain("max     = 6");
		expect(hcl).toContain("target = 70");

		// Traefik-via-Consul routing for the domain (HTTP + HTTPS + TLS resolver)
		expect(hcl).toContain('provider = "consul"');
		expect(hcl).toContain("traefik.enable=true");
		expect(hcl).toContain("Host(`app.example.com`)");
		expect(hcl).toContain("entrypoints=websecure");
		expect(hcl).toContain("tls.certresolver=letsencrypt");

		// HTTP health check derived from the compose healthcheck
		expect(hcl).toContain('type     = "http"');
		expect(hcl).toContain('path     = "/health"');
	});
});
