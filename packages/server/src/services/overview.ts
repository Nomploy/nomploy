import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
	applications,
	compose,
	domains,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "../db/schema";

/**
 * Org-wide aggregation for the cross-project Overview page. Each query returns a
 * FLAT array (one row per service / domain / backup) joined up to its project —
 * sidestepping the nested `project.all` shape (and its Postgres 100-arg
 * json_build_array limit, see [[nomploy-json-build-array-100-arg-limit]]) and the
 * column-trimming that drops DB names/status there.
 *
 * Scoping mirrors findAllDeploymentsCentralized: pass `accessedServices` for a
 * member (only those service ids) or `null` for owner/admin (the whole org).
 */

export type OverviewServiceType =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

export interface OverviewService {
	type: OverviewServiceType;
	id: string;
	name: string;
	appName: string | null;
	status: string | null;
	projectId: string;
	projectName: string;
	environmentId: string;
	environmentName: string;
}

export interface OverviewDomain {
	domainId: string;
	host: string;
	https: boolean;
	path: string | null;
	domainType: string | null;
	certificateType: string;
	serviceType: "application" | "compose";
	serviceId: string;
	serviceName: string;
	projectId: string;
	projectName: string;
	environmentId: string;
	environmentName: string;
}

export interface OverviewBackup {
	backupId: string;
	schedule: string;
	enabled: boolean;
	database: string;
	databaseType: string;
	backupType: string;
	destinationName: string | null;
	serviceId: string;
	serviceName: string;
	serviceType: string;
	projectId: string;
	projectName: string;
	environmentId: string;
	environmentName: string;
}

// Each service table shares { <id>, name, appName, applicationStatus, environmentId }
// (compose uses composeStatus). Build one select per type and concat.
const serviceQuery = async (
	type: OverviewServiceType,
	// Loosely typed (any): one helper indexes heterogeneous drizzle service
	// tables (applications/compose/postgres/…) by column name.
	table: any,
	idCol: string,
	statusCol: string,
	orgId: string,
	accessedServices: string[] | null,
): Promise<OverviewService[]> => {
	const where =
		accessedServices !== null
			? and(
					eq(projects.organizationId, orgId),
					inArray(table[idCol], accessedServices),
				)
			: eq(projects.organizationId, orgId);
	const rows = await db
		.select({
			id: table[idCol],
			name: table.name,
			appName: table.appName,
			status: table[statusCol],
			environmentId: environments.environmentId,
			environmentName: environments.name,
			projectId: projects.projectId,
			projectName: projects.name,
		})
		.from(table)
		.innerJoin(
			environments,
			eq(table.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(where);
	return rows.map((r) => ({ type, ...r }) as OverviewService);
};

export const findAllServicesCentralized = async (
	orgId: string,
	accessedServices: string[] | null,
): Promise<OverviewService[]> => {
	if (accessedServices !== null && accessedServices.length === 0) return [];
	const results = await Promise.all([
		serviceQuery(
			"application",
			applications,
			"applicationId",
			"applicationStatus",
			orgId,
			accessedServices,
		),
		serviceQuery(
			"compose",
			compose,
			"composeId",
			"composeStatus",
			orgId,
			accessedServices,
		),
		serviceQuery(
			"postgres",
			postgres,
			"postgresId",
			"applicationStatus",
			orgId,
			accessedServices,
		),
		serviceQuery(
			"mysql",
			mysql,
			"mysqlId",
			"applicationStatus",
			orgId,
			accessedServices,
		),
		serviceQuery(
			"mariadb",
			mariadb,
			"mariadbId",
			"applicationStatus",
			orgId,
			accessedServices,
		),
		serviceQuery(
			"mongo",
			mongo,
			"mongoId",
			"applicationStatus",
			orgId,
			accessedServices,
		),
		serviceQuery(
			"redis",
			redis,
			"redisId",
			"applicationStatus",
			orgId,
			accessedServices,
		),
		serviceQuery(
			"libsql",
			libsql,
			"libsqlId",
			"applicationStatus",
			orgId,
			accessedServices,
		),
	]);
	return results
		.flat()
		.sort(
			(a, b) =>
				a.projectName.localeCompare(b.projectName) ||
				a.name.localeCompare(b.name),
		);
};

export const findAllDomainsCentralized = async (
	orgId: string,
	accessedServices: string[] | null,
): Promise<OverviewDomain[]> => {
	if (accessedServices !== null && accessedServices.length === 0) return [];

	const appDomains = db
		.select({
			domainId: domains.domainId,
			host: domains.host,
			https: domains.https,
			path: domains.path,
			domainType: domains.domainType,
			certificateType: domains.certificateType,
			serviceId: applications.applicationId,
			serviceName: applications.name,
			projectId: projects.projectId,
			projectName: projects.name,
			environmentId: environments.environmentId,
			environmentName: environments.name,
		})
		.from(domains)
		.innerJoin(
			applications,
			eq(domains.applicationId, applications.applicationId),
		)
		.innerJoin(
			environments,
			eq(applications.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(
			accessedServices !== null
				? and(
						eq(projects.organizationId, orgId),
						inArray(applications.applicationId, accessedServices),
					)
				: eq(projects.organizationId, orgId),
		);

	const composeDomains = db
		.select({
			domainId: domains.domainId,
			host: domains.host,
			https: domains.https,
			path: domains.path,
			domainType: domains.domainType,
			certificateType: domains.certificateType,
			serviceId: compose.composeId,
			serviceName: compose.name,
			projectId: projects.projectId,
			projectName: projects.name,
			environmentId: environments.environmentId,
			environmentName: environments.name,
		})
		.from(domains)
		.innerJoin(compose, eq(domains.composeId, compose.composeId))
		.innerJoin(
			environments,
			eq(compose.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(
			accessedServices !== null
				? and(
						eq(projects.organizationId, orgId),
						inArray(compose.composeId, accessedServices),
					)
				: eq(projects.organizationId, orgId),
		);

	const [apps, comps] = await Promise.all([appDomains, composeDomains]);
	return [
		...apps.map((d) => ({ ...d, serviceType: "application" as const })),
		...comps.map((d) => ({ ...d, serviceType: "compose" as const })),
	].sort((a, b) => a.host.localeCompare(b.host));
};

export const findAllBackupsCentralized = async (
	orgId: string,
	accessedServices: string[] | null,
): Promise<OverviewBackup[]> => {
	if (accessedServices !== null && accessedServices.length === 0) return [];

	// Org service-id set (so a backup is kept only if its owning service is in the
	// org / accessible). Resolve owning-service name + project from the flat
	// services list, which is already org-scoped.
	const services = await findAllServicesCentralized(orgId, accessedServices);
	const byId = new Map(services.map((s) => [s.id, s]));

	const rows = await db.query.backups.findMany({
		with: { destination: { columns: { name: true } } },
	});

	const out: OverviewBackup[] = [];
	for (const b of rows) {
		const ownerId =
			b.composeId ||
			b.postgresId ||
			b.mariadbId ||
			b.mysqlId ||
			b.mongoId ||
			b.libsqlId;
		if (!ownerId) continue;
		const svc = byId.get(ownerId);
		if (!svc) continue; // not in this org / not accessible
		out.push({
			backupId: b.backupId,
			schedule: b.schedule,
			enabled: b.enabled ?? false,
			database: b.database,
			databaseType: b.databaseType,
			backupType: b.backupType,
			destinationName: b.destination?.name ?? null,
			serviceId: svc.id,
			serviceName: svc.name,
			serviceType: svc.type,
			projectId: svc.projectId,
			projectName: svc.projectName,
			environmentId: svc.environmentId,
			environmentName: svc.environmentName,
		});
	}
	return out.sort(
		(a, b) =>
			a.projectName.localeCompare(b.projectName) ||
			a.serviceName.localeCompare(b.serviceName),
	);
};
