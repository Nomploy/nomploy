import {
	applyServiceScalingOverrides,
	generateNomadJobSpec,
	getBuildNomadCommand,
	type NomadServiceSpec,
} from "@nomploy/server/utils/builders/nomad";
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
	it("translates a compose into per-service groups (independent mode)", async () => {
		// Independent mode puts each service in its own group, so per-service
		// replicas/spread/scaling from the compose actually take effect (shared mode
		// runs one group at count=1). The rich compose above exercises all of it.
		const cmd = await getBuildNomadCommand({
			...compose,
			deployMode: "independent",
		});

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

		// Resource limits translated (0.5 CPU -> 500 MHz, 512M -> 512 MB reservation)
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

		// A native jobspec is NOT run through the compose translator (no spread/dns
		// added) — but a single-job spec's id IS rewritten to the appName so the
		// panel's lifecycle/logs (keyed by appName) line up. So it equals the input
		// with only the job id swapped.
		expect(jobSpec).toBe(hcl.replace('job "raw-app"', 'job "rawapp"'));
		expect(jobSpec).toContain('job "rawapp"');
		expect(jobSpec).not.toContain("spread {");
		expect(jobSpec).not.toContain("service.consul");
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
		// CPU/memory limits still translate alongside the GPU request. A Docker
		// `limit` is a HARD cap → Nomad memory_max (burst ceiling); the reservation
		// stays at the default floor so the scheduler doesn't over-reserve.
		expect(hcl).toContain("cpu    = 2000");
		expect(hcl).toContain("memory = 512");
		expect(hcl).toContain("memory_max = 4096");
	});

	it("honors ${VAR:-default} / ${VAR-default} env defaults", async () => {
		const defCompose = {
			...compose,
			appName: "defenv",
			// TZ unset → :-default and -default both fall back; SET wins over its
			// default; bare ${MISSING} → empty.
			env: "SET=present",
			environment: { project: { env: "" }, env: null },
			composeFile: `
services:
  app:
    image: nginx:alpine
    environment:
      TZ: \${TZ:-UTC}
      DASH: \${MISSING-fallback}
      KEPT: \${SET:-ignored}
      EMPTY: \${MISSING}
`,
			domains: [],
		};
		const cmd = await getBuildNomadCommand(defCompose);
		const hcl = Buffer.from(
			cmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1] ?? "",
			"base64",
		).toString("utf8");
		expect(hcl).toContain('TZ = "UTC"');
		expect(hcl).toContain('DASH = "fallback"');
		expect(hcl).toContain('KEPT = "present"');
		expect(hcl).toContain('EMPTY = ""');
	});

	it("force_pull: moving tags by default, all when forcePull=true", async () => {
		const base = {
			...compose,
			appName: "fpjob",
			composeFile: `
services:
  web:
    image: myrepo/web:latest
  db:
    image: postgres:17-alpine
`,
			domains: [],
		};
		const hclOf = async (c: unknown) =>
			Buffer.from(
				(await getBuildNomadCommand(c as typeof compose)).match(
					/echo "([A-Za-z0-9+/=]+)" \| base64 -d/,
				)?.[1] ?? "",
				"base64",
			).toString("utf8");

		// Default (forcePull unset): only the moving :latest tag re-pulls.
		const def = await hclOf(base);
		expect(def).toMatch(/image = "myrepo\/web:latest"\n\s*force_pull = true/);
		expect(def).not.toMatch(
			/image = "postgres:17-alpine"\n\s*force_pull = true/,
		);

		// forcePull = true: every image re-pulls, even the pinned one.
		const forced = await hclOf({ ...base, forcePull: true });
		expect(forced).toMatch(
			/image = "postgres:17-alpine"\n\s*force_pull = true/,
		);

		// forcePull = false: nothing re-pulls (operator opted out).
		const off = await hclOf({ ...base, forcePull: false });
		expect(off).not.toContain("force_pull = true");
	});

	it("persists compose volumes as docker volumes (named/bind/anonymous)", async () => {
		const volCompose = {
			...compose,
			appName: "voljob",
			composeFile: `
services:
  db:
    image: postgres:17-alpine
    volumes:
      - db_data:/var/lib/postgresql/data
      - /etc/host/conf:/etc/conf:ro
      - /cache
volumes:
  db_data:
`,
			domains: [],
		};

		const cmd = await getBuildNomadCommand(volCompose);
		const hcl = Buffer.from(
			cmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1] ?? "",
			"base64",
		).toString("utf8");

		// Named volume → a real docker named-volume MOUNT stanza (persists + inherits
		// the image dir's ownership, so a non-root container can write). NOT a bare
		// "name:/path" in volumes (Nomad would make that a root-owned alloc bind).
		expect(hcl).toContain('type   = "volume"');
		expect(hcl).toContain('source = "voljob-db_data"');
		expect(hcl).toContain('target = "/var/lib/postgresql/data"');
		expect(hcl).not.toContain('"voljob-db_data:/var/lib/postgresql/data"');
		// Absolute bind mount still passes through the volumes list, mode preserved.
		expect(hcl).toContain('"/etc/host/conf:/etc/conf:ro"');
		// Anonymous volume → an app+target-scoped named volume mount.
		expect(hcl).toContain('source = "voljob-cache"');
		expect(hcl).toContain('target = "/cache"');
	});

	it("renders inline compose configs as file-mount templates", async () => {
		const cfgCompose = {
			...compose,
			appName: "cfgjob",
			composeFile: `
services:
  web:
    image: nginx:alpine
    configs:
      - source: nginx_conf
        target: /etc/nginx/nginx.conf
      - shorty
configs:
  nginx_conf:
    content: |
      server { listen 8080; }
  shorty:
    content: "hello there"
`,
			domains: [],
		};

		const cmd = await getBuildNomadCommand(cfgCompose);
		const hcl = Buffer.from(
			cmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1] ?? "",
			"base64",
		).toString("utf8");

		// Inline config content → a Nomad template stanza with the content verbatim…
		expect(hcl).toContain("template {");
		expect(hcl).toContain("server { listen 8080; }");
		expect(hcl).toContain("hello there");
		// …mounted at the long-syntax target and the short-syntax default (/<name>).
		expect(hcl).toContain(":/etc/nginx/nginx.conf");
		expect(hcl).toContain(":/shorty");
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

	it("emits the secrets template only when a service opts in", () => {
		const base: NomadServiceSpec = {
			name: "app",
			image: "nginx:latest",
			ports: [],
			replicas: 1,
			env: { FOO: "bar" },
		};

		// No secrets → no template block, no Nomad Variable reference.
		const without = generateNomadJobSpec("secretapp", [base], []);
		expect(without).not.toContain("template {");
		expect(without).not.toContain("nomadVar");

		// Opted in → a template reads the job's own variable and injects it as env.
		// The secret VALUES are never inlined — only the reference to the variable.
		const withSecrets = generateNomadJobSpec(
			"secretapp",
			[{ ...base, secrets: true }],
			[],
		);
		expect(withSecrets).toContain("template {");
		expect(withSecrets).toContain('nomadVar "nomad/jobs/secretapp"');
		expect(withSecrets).toContain("env         = true");
		expect(withSecrets).toContain('change_mode = "restart"');
		// nomadVar returns the items map directly — range over `.`, not `.Items`
		// (verified on-cluster: `.Items` fails to iterate). Guard the regression.
		expect(withSecrets).toContain("range $k, $v := .");
		expect(withSecrets).not.toContain(".Items");
	});

	it("default deploy: zero-downtime canary unless a RW volume is present", async () => {
		const hclOf = async (composeFile: string) =>
			Buffer.from(
				(
					await getBuildNomadCommand({
						...compose,
						appName: "rollapp",
						composeFile,
						domains: [],
					} as typeof compose)
				).match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1] ?? "",
				"base64",
			).toString("utf8");

		// Stateless (no volumes) → canary + auto_promote (zero-downtime).
		const stateless = await hclOf(
			"services:\n  web:\n    image: nginx:latest\n    ports:\n      - '80'\n",
		);
		expect(stateless).toContain("canary           = 1");
		expect(stateless).toContain("auto_promote     = true");
		expect(stateless).toContain("auto_revert      = true");

		// A RW volume → no canary (can't share an exclusive-writer volume), plain
		// rolling restart with auto_revert.
		const stateful = await hclOf(
			"services:\n  db:\n    image: postgres:17-alpine\n    volumes:\n      - data:/var/lib/postgresql/data\nvolumes:\n  data:\n",
		);
		expect(stateful).not.toContain("canary");
		expect(stateful).toContain("auto_revert      = true");

		// A read-only volume is shareable → canary still allowed.
		const roVol = await hclOf(
			"services:\n  web:\n    image: nginx:latest\n    ports:\n      - '80'\n    volumes:\n      - assets:/usr/share/nginx/html:ro\nvolumes:\n  assets:\n",
		);
		expect(roVol).toContain("canary           = 1");
	});

	it("emits canary/update stanza only when a strategy is set", () => {
		const base: NomadServiceSpec = {
			name: "app",
			image: "nginx:latest",
			ports: [],
			replicas: 3,
			env: {},
		};

		// Default: rolling, one at a time, no canary lines (unchanged behavior).
		const rolling = generateNomadJobSpec("rollapp", [base], []);
		expect(rolling).toContain("max_parallel     = 1");
		expect(rolling).not.toContain("canary");
		expect(rolling).toContain("auto_revert      = true");

		// Canary with manual promotion.
		const canary = generateNomadJobSpec("canapp", [base], [], undefined, null, {
			maxParallel: 2,
			canary: 3,
			autoPromote: false,
		});
		expect(canary).toContain("max_parallel     = 2");
		expect(canary).toContain("canary           = 3");
		expect(canary).toContain("auto_promote     = false");

		// Canary with auto-promotion.
		const auto = generateNomadJobSpec("autoapp", [base], [], undefined, null, {
			maxParallel: 1,
			canary: 1,
			autoPromote: true,
		});
		expect(auto).toContain("auto_promote     = true");
	});
});

// A compose with two port-bearing services so cross-service discovery matters.
const twoServiceCompose = {
	...compose,
	appName: "twoapp",
	env: "",
	environment: { project: { env: null }, env: null },
	domains: [],
	composeFile: `
services:
  api:
    image: myreg/api:latest
    ports:
      - "3000"
    deploy:
      replicas: 3
  db:
    image: postgres:16
    ports:
      - "5432"
`,
} as typeof compose;

describe("nomad builder — independent (per-service) compose mode", () => {
	const decode = async (c: unknown): Promise<string> => {
		const cmd = await getBuildNomadCommand(
			c as Parameters<typeof getBuildNomadCommand>[0],
		);
		const match = cmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/);
		return Buffer.from(match?.[1] ?? "", "base64").toString("utf8");
	};

	it("shared mode (default) keeps a single shared-netns group", async () => {
		const hcl = await decode(twoServiceCompose);
		// One group named after the app, both services as tasks inside it.
		expect(hcl).toContain('group "twoapp"');
		expect(hcl).toContain('task "api"');
		expect(hcl).toContain('task "db"');
		expect(hcl).not.toContain('group "api"');
		// Single group scales as a unit at count=1 (per-service replicas ignored).
		expect(hcl).toContain("count = 1");
		expect(hcl).not.toContain("count = 3");
		// Localhost discovery via extra_hosts; no alloc addressing, no /etc/hosts alias.
		expect(hcl).toContain("extra_hosts");
		expect(hcl).not.toContain('address_mode = "alloc"');
		expect(hcl).not.toContain("/etc/hosts");
	});

	it("shared mode still applies the compose-faithful translation", async () => {
		// The rich compose (env, resources, domain, healthcheck) in the default mode.
		const hcl = await decode(compose);
		expect(hcl).toContain('job "myapp"');
		expect(hcl).toContain('group "myapp"');
		expect(hcl).toContain('task "web"');
		expect(hcl).toContain('task "worker"');
		// Env resolution, resources, Traefik routing, and health check all survive.
		expect(hcl).toContain("https://api.example.com");
		expect(hcl).toContain("cpu    = 500");
		expect(hcl).toContain("traefik.enable=true");
		expect(hcl).toContain('path     = "/health"');
	});

	it("independent mode spreads multi-replica services across nodes", async () => {
		const hcl = await decode({
			...twoServiceCompose,
			deployMode: "independent",
		});
		// api has replicas=3 → its group spreads across distinct nodes; db (1) doesn't
		// need to, but the assertion just confirms spread is emitted for the scaled one.
		expect(hcl).toContain("spread {");
		expect(hcl).toContain("node.unique.id");
	});

	it("independent mode emits one group per service that scales on its own", async () => {
		const hcl = await decode({
			...twoServiceCompose,
			deployMode: "independent",
		});

		// One Nomad group per service (not a single shared group).
		expect(hcl).toContain('group "api"');
		expect(hcl).toContain('group "db"');
		expect(hcl).not.toContain('group "twoapp"');

		// Each service scales on its own count (api: deploy.replicas=3, db: 1).
		expect(hcl).toContain("count = 3");
		expect(hcl).toContain("count = 1");

		// Host networking (no bridge/mesh) with a STATIC host port pinned to the
		// container port, so `<name>:<native port>` reaches it over the WG overlay.
		expect(hcl).not.toContain('mode = "bridge"');
		expect(hcl).not.toContain('address_mode = "alloc"');
		expect(hcl).not.toContain("connect {");
		expect(hcl).not.toContain("sidecar_service");
		expect(hcl).toContain("static = 3000");
		expect(hcl).toContain("static = 5432");

		// App-scoped names (no cross-app collision), registered for sibling discovery
		// with the Nomad-native provider (Consul-ACL-free templates).
		expect(hcl).toContain('name     = "twoapp-api-3000"');
		expect(hcl).toContain('name     = "twoapp-db-5432"');
		expect(hcl).toContain('provider = "nomad"');
	});

	it("independent mode preserves bare-name discovery via /etc/hosts aliases", async () => {
		const hcl = await decode({
			...twoServiceCompose,
			deployMode: "independent",
		});

		// Each consumer gets a rendered /etc/hosts that aliases the sibling's bare
		// compose name to that sibling's node wg IP (via Nomad-native discovery) — so
		// `db:5432` / `api:3000` keep working with no env rewriting.
		expect(hcl).toContain('destination     = "local/hosts"');
		expect(hcl).toContain('"local/hosts:/etc/hosts"');
		expect(hcl).toContain('{{- range nomadService "twoapp-db-5432" }}');
		expect(hcl).toContain("{{ .Address }} db");
		expect(hcl).toContain('{{- range nomadService "twoapp-api-3000" }}');
		expect(hcl).toContain("{{ .Address }} api");
		// Standard loopback entries survive (we bind-mount over Docker's /etc/hosts).
		expect(hcl).toContain("127.0.0.1 localhost");
	});
});

describe("nomad builder — per-service scaling overrides (UI)", () => {
	const base = (): NomadServiceSpec[] => [
		{ name: "web", image: "web:latest", ports: [], replicas: 1, env: {} },
		{ name: "db", image: "postgres:16", ports: [], replicas: 1, env: {} },
	];

	it("overrides replicas from the UI (wins over compose)", () => {
		const services = base();
		applyServiceScalingOverrides(services, { web: { replicas: 4 } });
		expect(services.find((s) => s.name === "web")?.replicas).toBe(4);
		expect(services.find((s) => s.name === "db")?.replicas).toBe(1);
	});

	it("enables autoscaling from the UI and starts at min", () => {
		const services = base();
		applyServiceScalingOverrides(services, {
			web: { autoscaling: { enabled: true, min: 2, max: 6, cpuTarget: 65 } },
		});
		const web = services.find((s) => s.name === "web");
		expect(web?.scaling).toEqual(
			expect.objectContaining({ min: 2, max: 6, cpuTarget: 65 }),
		);
		expect(web?.replicas).toBe(2); // starts at min
	});

	it("defaults a CPU target when autoscaling is enabled with none set", () => {
		const services = base();
		applyServiceScalingOverrides(services, {
			web: { autoscaling: { enabled: true, min: 1, max: 3 } },
		});
		expect(services.find((s) => s.name === "web")?.scaling?.cpuTarget).toBe(70);
	});

	it("disabling autoscaling from the UI clears any compose scaling", () => {
		const services = base();
		services[0]!.scaling = { min: 1, max: 5, cpuTarget: 80 };
		applyServiceScalingOverrides(services, {
			web: { autoscaling: { enabled: false, min: 1, max: 1 } },
		});
		expect(services.find((s) => s.name === "web")?.scaling).toBeUndefined();
	});

	it("leaves services absent from the override map untouched", () => {
		const services = base();
		services[1]!.replicas = 2;
		applyServiceScalingOverrides(services, { web: { replicas: 3 } });
		expect(services.find((s) => s.name === "db")?.replicas).toBe(2);
	});
});

describe("nomad builder — deploy stamp forces a re-pull", () => {
	it("stamps a job-level meta.deployed_at on every deploy", async () => {
		// getBuildNomadCommand always stamps so Nomad creates a NEW alloc (force_pull
		// only re-pulls on alloc creation; an unchanged spec would no-op).
		const cmd = await getBuildNomadCommand(compose);
		const hcl = Buffer.from(
			cmd.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1] ?? "",
			"base64",
		).toString("utf8");
		expect(hcl).toContain("meta {");
		expect(hcl).toContain("deployed_at =");
	});
});

describe("nomad builder — shared-mode group autoscaling", () => {
	it("emits a scaling block on the single group when enabled", async () => {
		const hcl = Buffer.from(
			(
				await getBuildNomadCommand({
					...compose,
					deployMode: "shared",
					autoscalingEnabled: true,
					minReplicas: 2,
					maxReplicas: 5,
					autoscaleCpuTarget: 65,
					// biome-ignore lint/suspicious/noExplicitAny: test mock
				} as any)
			).match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)?.[1] ?? "",
			"base64",
		).toString("utf8");
		// Single group (shared) that now scales as a unit, starting at min.
		expect(hcl).toContain('group "myapp"');
		expect(hcl).toContain("count = 2");
		expect(hcl).toContain("scaling {");
		expect(hcl).toContain("max     = 5");
		expect(hcl).toContain("target = 65");
	});

	it("stays at count=1 with no scaling when disabled", async () => {
		const hcl = Buffer.from(
			(await getBuildNomadCommand({ ...compose, deployMode: "shared" })).match(
				/echo "([A-Za-z0-9+/=]+)" \| base64 -d/,
			)?.[1] ?? "",
			"base64",
		).toString("utf8");
		expect(hcl).toContain("count = 1");
		expect(hcl).not.toContain("scaling {");
	});
});
