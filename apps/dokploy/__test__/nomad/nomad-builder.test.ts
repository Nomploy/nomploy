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
		console.log(
			"\n===== generated Nomad HCL =====\n" +
				hcl +
				"\n===============================\n",
		);

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

	it("deploys a native Nomad HCL jobspec verbatim (no translation)", async () => {
		const hcl = `job "raw-app" {
  type = "service"
  group "web" {
    task "server" {
      driver = "docker"
      config { image = "nginx:alpine" }
    }
  }
}`;
		const hclCompose = {
			...compose,
			appName: "rawapp",
			composeFile: hcl,
			domains: [],
		};

		const cmd = await getBuildNomadCommand(hclCompose);
		const match = cmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/);
		const jobSpec = Buffer.from(match?.[1] ?? "", "base64").toString("utf8");

		// The jobspec is written out byte-for-byte — not run through the compose
		// translator (which would rename the job to the appName + add spread/dns).
		expect(jobSpec).toBe(hcl);
		expect(jobSpec).toContain('job "raw-app"');
		// A native jobspec skips the docker compose build/push steps.
		expect(cmd).not.toContain("docker compose build");
		expect(cmd).toContain("nomad job run");
	});

	it("translates a GPU reservation into a Nomad device stanza", async () => {
		const gpuCompose = {
			...compose,
			appName: "gpuapp",
			composeFile: `
services:
  trainer:
    image: myregistry/trainer:latest
    deploy:
      resources:
        limits:
          cpus: "2"
          memory: 4G
        reservations:
          devices:
            - driver: nvidia
              count: 2
              capabilities: [gpu]
`,
			domains: [],
		};

		const cmd = await getBuildNomadCommand(gpuCompose);
		const match = cmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/);
		const hcl = Buffer.from(match?.[1] ?? "", "base64").toString("utf8");

		// GPU request → nomad-device-nvidia device stanza with the requested count,
		// nested inside the task's resources block.
		expect(hcl).toContain('device "nvidia/gpu"');
		expect(hcl).toContain("count = 2");
		// CPU/memory limits still translate alongside the GPU request.
		expect(hcl).toContain("cpu    = 2000");
		expect(hcl).toContain("memory = 4096");
	});

	it("emits node_pool only when the compose targets an autoscaling group", async () => {
		// No pool → the job runs in the default pool (no node_pool stanza).
		const defCmd = await getBuildNomadCommand(compose);
		const defHcl = Buffer.from(
			defCmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1] ?? "",
			"base64",
		).toString("utf8");
		expect(defHcl).not.toContain("node_pool");

		// A group's pool → node_pool stanza at the job level.
		const poolCmd = await getBuildNomadCommand({
			...compose,
			appName: "poolapp",
			nodePool: "memory",
		});
		const poolHcl = Buffer.from(
			poolCmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1] ?? "",
			"base64",
		).toString("utf8");
		expect(poolHcl).toContain('node_pool = "memory"');

		// "default" is the built-in pool — treated as no explicit targeting.
		const explicitDefault = await getBuildNomadCommand({
			...compose,
			appName: "defpoolapp",
			nodePool: "default",
		});
		const defPoolHcl = Buffer.from(
			explicitDefault.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1] ?? "",
			"base64",
		).toString("utf8");
		expect(defPoolHcl).not.toContain("node_pool");
	});
});
