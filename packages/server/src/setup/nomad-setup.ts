import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { paths } from "../constants";

const execAsync = promisify(exec);

export const TRAEFIK_PORT =
	Number.parseInt(process.env.TRAEFIK_PORT!, 10) || 80;
export const TRAEFIK_SSL_PORT =
	Number.parseInt(process.env.TRAEFIK_SSL_PORT!, 10) || 443;
const CONSUL_ADDRESS =
	process.env.CONSUL_ADDRESS || "http://127.0.0.1:8500";
const NOMAD_ADDRESS = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
const TRAEFIK_NETWORK = process.env.TRAEFIK_NETWORK || "host";
const TRAEFIK_CONSUL_ADDRESS =
	process.env.TRAEFIK_CONSUL_ADDRESS || CONSUL_ADDRESS;

/**
 * Full Nomad-based setup: Postgres, Redis, Traefik (all as plain Docker containers)
 * Requires: Docker, Nomad, Consul running.
 */
export const setupNomad = async () => {
	await ensureConsulRunning();
	await ensureNomadRunning();
	await checkDockerAuthForNomad();
	await initializePostgresContainer();
	await initializeRedisContainer();
	await initializeTraefikNomad();
	await initializeNomadAutoscaler();
	console.log("Nomad setup completed ✅");
};

const ensureConsulRunning = async () => {
	try {
		await execAsync("consul members");
		console.log("Consul is running ✅");
	} catch {
		throw new Error(
			"Consul is not running. Start it with: consul agent -dev",
		);
	}
};

const checkDockerAuthForNomad = async () => {
	const dockerConfigPath = "/root/.docker/config.json";
	if (existsSync(dockerConfigPath)) {
		console.log("Docker auth config found ✅");
	} else {
		console.warn(
			"⚠️  Docker auth config not found at /root/.docker/config.json\n" +
			"   Nomad won't be able to pull from private registries.\n" +
			"   Run 'docker login <registry>' to configure.",
		);
	}
};

const ensureNomadRunning = async () => {
	try {
		await execAsync("nomad server members");
		console.log("Nomad is running ✅");
	} catch {
		throw new Error(
			`Nomad is not running. Start it with:\n` +
			`  nomad agent -dev -bind=127.0.0.1\n\n` +
			`For production, ensure your Nomad client config includes:\n` +
			`  plugin "docker" {\n` +
			`    config {\n` +
			`      auth {\n` +
			`        config = "/root/.docker/config.json"\n` +
			`      }\n` +
			`    }\n` +
			`  }`,
		);
	}
};

const initializePostgresContainer = async () => {
	const name = "nomploy-postgres";
	try {
		const { stdout } = await execAsync(
			`docker ps -q --filter "name=${name}" --filter "status=running"`,
		);
		if (stdout.trim()) {
			console.log("Postgres already running ✅");
			return;
		}
	} catch {}

	// Remove stopped container if exists
	await execAsync(`docker rm -f ${name} 2>/dev/null || true`);

	await execAsync(`docker run -d --name ${name} \
		-e POSTGRES_USER=nomploy \
		-e POSTGRES_DB=nomploy \
		-e POSTGRES_PASSWORD=amukds4wi9001583845717ad2 \
		-v nomploy-postgres:/var/lib/postgresql/data \
		-p 5432:5432 \
		--restart unless-stopped \
		postgres:16`);
	console.log("Postgres started ✅");
};

const initializeRedisContainer = async () => {
	const name = "nomploy-redis";
	try {
		const { stdout } = await execAsync(
			`docker ps -q --filter "name=${name}" --filter "status=running"`,
		);
		if (stdout.trim()) {
			console.log("Redis already running ✅");
			return;
		}
	} catch {}

	await execAsync(`docker rm -f ${name} 2>/dev/null || true`);

	await execAsync(`docker run -d --name ${name} \
		-v nomploy-redis:/data \
		-p 6379:6379 \
		--restart unless-stopped \
		redis:7`);
	console.log("Redis started ✅");
};

const initializeTraefikNomad = async () => {
	const name = "nomploy-traefik";
	try {
		const { stdout } = await execAsync(
			`docker ps -q --filter "name=${name}" --filter "status=running"`,
		);
		if (stdout.trim()) {
			console.log("Traefik already running ✅");
			return;
		}
	} catch {}

	await execAsync(`docker rm -f ${name} 2>/dev/null || true`);

	// Create traefik config directory
	const { MAIN_TRAEFIK_PATH } = paths(false);
	if (!existsSync(MAIN_TRAEFIK_PATH)) {
		mkdirSync(MAIN_TRAEFIK_PATH, { recursive: true });
	}

	// Write static config
	const traefikConfig = `
entryPoints:
  web:
    address: ":${TRAEFIK_PORT}"
  websecure:
    address: ":${TRAEFIK_SSL_PORT}"

providers:
  consulCatalog:
    endpoint:
      address: "${TRAEFIK_CONSUL_ADDRESS}"
    exposedByDefault: false
    prefix: traefik

api:
  insecure: true
  dashboard: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@localhost
      storage: /etc/traefik/acme.json
      httpChallenge:
        entryPoint: web
`;

	const configPath = `${MAIN_TRAEFIK_PATH}/traefik.yml`;
	writeFileSync(configPath, traefikConfig);

	// Create acme.json
	const acmePath = `${MAIN_TRAEFIK_PATH}/acme.json`;
	if (!existsSync(acmePath)) {
		writeFileSync(acmePath, "");
		await execAsync(`chmod 600 ${acmePath}`);
	}

	const { DYNAMIC_TRAEFIK_PATH } = paths(false);
	if (!existsSync(DYNAMIC_TRAEFIK_PATH)) {
		mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	}

	const networkFlag = TRAEFIK_NETWORK === "host"
		? "--network host"
		: `-p ${TRAEFIK_PORT}:${TRAEFIK_PORT} -p ${TRAEFIK_SSL_PORT}:${TRAEFIK_SSL_PORT} -p 8080:8080`;

	await execAsync(`docker run -d --name ${name} \
		${networkFlag} \
		-v ${configPath}:/etc/traefik/traefik.yml:ro \
		-v ${acmePath}:/etc/traefik/acme.json \
		-v ${DYNAMIC_TRAEFIK_PATH}:/etc/nomploy/traefik/dynamic \
		--restart unless-stopped \
		traefik:v3.0`);
	console.log("Traefik (Consul Catalog) started ✅");
};

const initializeNomadAutoscaler = async () => {
	const name = "nomad-autoscaler";
	try {
		const { stdout } = await execAsync(
			`docker ps -q --filter "name=${name}" --filter "status=running"`,
		);
		if (stdout.trim()) {
			console.log("Nomad Autoscaler already running ✅");
			return;
		}
	} catch {}

	await execAsync(`docker rm -f ${name} 2>/dev/null || true`);

	await execAsync(`docker run -d --name ${name} \
		--network host \
		--restart unless-stopped \
		hashicorp/nomad-autoscaler:latest \
		agent \
		-nomad-address=${NOMAD_ADDRESS} \
		-http-bind-address=127.0.0.1 \
		-http-bind-port=8081`);
	console.log("Nomad Autoscaler started ✅");
};
