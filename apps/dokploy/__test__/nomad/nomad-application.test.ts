import {
	applicationToNomadSpec,
	generateApplicationNomadJob,
	resolveApplicationImage,
} from "@nomploy/server/utils/builders/nomad-application";
import { describe, expect, it } from "vitest";

// A built (github) application: 2 replicas, a CPU/memory limit, one port, a
// domain, resolved env, and a registry so the image is pullable cluster-wide.
const application = {
	appName: "myapp-abc123",
	sourceType: "github",
	dockerImage: null,
	replicas: 2,
	// Swarm units: NanoCPUs (0.5 core) and bytes (256 MB).
	cpuLimit: "500000000",
	memoryLimit: "268435456",
	command: null,
	args: null,
	env: "PUBLIC_URL=${{project.BASE}}\nNODE_ENV=production",
	environment: {
		project: { env: "BASE=https://app.example.com" },
		env: null,
	},
	ports: [{ targetPort: 3000, publishedPort: 3000, protocol: "tcp" }],
	registry: {
		registryUrl: "registry.example.com",
		username: "u",
		password: "p",
		registryType: "cloud",
		imagePrefix: null,
	},
	buildRegistry: null,
	serverId: null,
	// biome-ignore lint/suspicious/noExplicitAny: test mock of ApplicationNested
} as any;

const domains = [
	{
		serviceName: "app",
		port: 3000,
		host: "myapp.example.com",
		https: true,
		path: "/",
		uniqueConfigKey: 1,
		customCertResolver: "letsencrypt",
	},
	// biome-ignore lint/suspicious/noExplicitAny: test mock of Domain[]
] as any;

describe("nomad application builder — application → HCL", () => {
	it("maps a built application onto a Nomad job", () => {
		const spec = applicationToNomadSpec(application);
		// 0.5 core -> 500 MHz, 256 MB -> 256 MB
		expect(spec.resources).toEqual({ cpu: 500, memory: 256 });
		expect(spec.replicas).toBe(2);
		// env: project var interpolated + static kept
		expect(spec.env.PUBLIC_URL).toBe("https://app.example.com");
		expect(spec.env.NODE_ENV).toBe("production");

		const hcl = generateApplicationNomadJob(application, domains);
		expect(hcl).toContain('job "myapp-abc123"');
		expect(hcl).toContain('group "app"');
		expect(hcl).toContain("count = 2");
		// multi-replica spread across nodes
		expect(hcl).toContain("spread {");
		// registry image (registryUrl/prefix/repo) so any node can pull it
		expect(hcl).toContain("registry.example.com/u/myapp-abc123:latest");
		expect(hcl).toContain("to = 3000");
		// Traefik-via-Consul routing for the domain
		expect(hcl).toContain('provider = "consul"');
		expect(hcl).toContain("traefik.enable=true");
		expect(hcl).toContain("Host(`myapp.example.com`)");
		expect(hcl).toContain("tls.certresolver=letsencrypt");
	});

	it("derives the network port from a domain when the app has no ports", () => {
		const appNoPorts = { ...application, ports: [] };
		const domainOnly = [
			{
				serviceName: "app",
				port: 8080,
				host: "only-domain.example.com",
				https: false,
				path: "/",
				uniqueConfigKey: 1,
			},
			// biome-ignore lint/suspicious/noExplicitAny: test mock of Domain[]
		] as any;
		const spec = applicationToNomadSpec(appNoPorts, domainOnly);
		expect(spec.ports.map((p) => p.to)).toEqual([8080]);
		const hcl = generateApplicationNomadJob(appNoPorts, domainOnly);
		expect(hcl).toContain("to = 8080");
		expect(hcl).toContain('provider = "consul"');
		expect(hcl).toContain("Host(`only-domain.example.com`)");
	});

	it("uses the docker image directly for docker-source apps", () => {
		const dockerApp = {
			...application,
			sourceType: "docker",
			dockerImage: "nginx:alpine",
			registry: null,
		};
		expect(resolveApplicationImage(dockerApp)).toBe("nginx:alpine");
	});
});
