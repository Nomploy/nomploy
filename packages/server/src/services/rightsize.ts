import { rightsizeApplication } from "./application";
import { deployLibsql, updateLibsqlById } from "./libsql";
import { deployMariadb, updateMariadbById } from "./mariadb";
import { deployMongo, updateMongoById } from "./mongo";
import { deployMySql, updateMySqlById } from "./mysql";
import { deployPostgres, updatePostgresById } from "./postgres";
import { deployRedis, updateRedisById } from "./redis";

/**
 * Apply a right-size recommendation to any supported service: set its reserved
 * CPU (MHz) + memory (MB) and re-submit the Nomad job. Applications reload without
 * a rebuild (zero-downtime canary when volumeless); databases re-deploy their job
 * (a brief restart — they hold a RW volume so there's no canary). Compose has no
 * reserved-resource field (resources live in its file), so it's not supported here.
 *
 * Limits are stored in the legacy units the builders expect: cpuLimit = NanoCPUs
 * (1 core = 1e9; builder ÷1e6 → MHz), memoryLimit = bytes (÷1024² → MB).
 */
const toLimits = (cpuMhz: number, memMb: number) => ({
	cpuLimit: String(Math.max(10, Math.round(cpuMhz)) * 1_000_000),
	memoryLimit: String(Math.max(16, Math.round(memMb)) * 1024 * 1024),
});

export const RIGHTSIZEABLE = [
	"application",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
] as const;

export const rightsizeService = async (
	serviceType: string,
	serviceId: string,
	cpuMhz: number,
	memMb: number,
): Promise<void> => {
	if (serviceType === "application") {
		await rightsizeApplication(serviceId, cpuMhz, memMb);
		return;
	}
	const limits = toLimits(cpuMhz, memMb);
	switch (serviceType) {
		case "postgres":
			await updatePostgresById(serviceId, limits);
			await deployPostgres(serviceId);
			return;
		case "mysql":
			await updateMySqlById(serviceId, limits);
			await deployMySql(serviceId);
			return;
		case "mariadb":
			await updateMariadbById(serviceId, limits);
			await deployMariadb(serviceId);
			return;
		case "mongo":
			await updateMongoById(serviceId, limits);
			await deployMongo(serviceId);
			return;
		case "redis":
			await updateRedisById(serviceId, limits);
			await deployRedis(serviceId);
			return;
		case "libsql":
			await updateLibsqlById(serviceId, limits);
			await deployLibsql(serviceId);
			return;
		default:
			throw new Error(`Right-size not supported for service type ${serviceType}`);
	}
};
