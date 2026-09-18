import { db } from "@nomploy/server/db";
import {
	type apiCreateProject,
	applications,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "@nomploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { createProductionEnvironment } from "./environment";

export type Project = typeof projects.$inferSelect;

export const createProject = async (
	input: z.infer<typeof apiCreateProject>,
	organizationId: string,
) => {
	const newProject = await db
		.insert(projects)
		.values({
			...input,
			organizationId: organizationId,
		})
		.returning()
		.then((value) => value[0]);

	if (!newProject) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the project",
		});
	}

	// Automatically create a production environment
	const newEnvironment = await createProductionEnvironment(
		newProject.projectId,
	);
	return {
		project: newProject,
		environment: newEnvironment,
	};
};

export const findProjectById = async (projectId: string) => {
	// Load only summary columns for each service, not every column. The Dokploy
	// application table alone is ~99 columns; selecting all of them across every
	// service type builds a json_build_array that exceeds Postgres's 100-argument
	// limit ("cannot pass more than 100 arguments to a function"), which broke this
	// query (and thus opening a project). The list/overview only needs id, name,
	// status, etc. — full config is fetched per-service via its own `.one` query.
	const serverCols = { columns: { name: true, serverId: true } } as const;
	const project = await db.query.projects.findFirst({
		where: eq(projects.projectId, projectId),
		with: {
			environments: {
				with: {
					applications: {
						with: { server: serverCols },
						columns: {
							name: true,
							applicationId: true,
							createdAt: true,
							applicationStatus: true,
							description: true,
							serverId: true,
							icon: true,
						},
					},
					compose: {
						with: { server: serverCols },
						columns: {
							composeId: true,
							name: true,
							createdAt: true,
							composeStatus: true,
							description: true,
							serverId: true,
						},
					},
					libsql: {
						with: { server: serverCols },
						columns: {
							libsqlId: true,
							name: true,
							createdAt: true,
							applicationStatus: true,
							description: true,
							serverId: true,
						},
					},
					mariadb: {
						with: { server: serverCols },
						columns: {
							mariadbId: true,
							name: true,
							createdAt: true,
							applicationStatus: true,
							description: true,
							serverId: true,
						},
					},
					mongo: {
						with: { server: serverCols },
						columns: {
							mongoId: true,
							name: true,
							createdAt: true,
							applicationStatus: true,
							description: true,
							serverId: true,
						},
					},
					mysql: {
						with: { server: serverCols },
						columns: {
							mysqlId: true,
							name: true,
							createdAt: true,
							applicationStatus: true,
							description: true,
							serverId: true,
						},
					},
					postgres: {
						with: { server: serverCols },
						columns: {
							postgresId: true,
							name: true,
							createdAt: true,
							applicationStatus: true,
							description: true,
							serverId: true,
						},
					},
					redis: {
						with: { server: serverCols },
						columns: {
							redisId: true,
							name: true,
							createdAt: true,
							applicationStatus: true,
							description: true,
							serverId: true,
						},
					},
				},
			},
			projectTags: {
				with: {
					tag: true,
				},
			},
		},
	});
	if (!project) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Project not found",
		});
	}
	return project;
};

export const deleteProject = async (projectId: string) => {
	const project = await db
		.delete(projects)
		.where(eq(projects.projectId, projectId))
		.returning()
		.then((value) => value[0]);

	return project;
};

export const updateProjectById = async (
	projectId: string,
	projectData: Partial<Project>,
) => {
	const result = await db
		.update(projects)
		.set({
			...projectData,
		})
		.where(eq(projects.projectId, projectId))
		.returning()
		.then((res) => res[0]);

	return result;
};

export const validUniqueServerAppName = async (appName: string) => {
	// Only the row COUNT per relation is used below, so select a single id column
	// each. Without `columns`, drizzle selects every column into a json_build_array
	// that overflows Postgres's 100-argument limit (the application table alone is
	// ~99 cols) — which made EVERY compose/service create throw. See
	// [[nomploy-json-build-array-100-arg-limit]].
	const query = await db.query.environments.findMany({
		columns: { environmentId: true },
		with: {
			applications: {
				where: eq(applications.appName, appName),
				columns: { applicationId: true },
			},
			libsql: {
				where: eq(libsql.appName, appName),
				columns: { libsqlId: true },
			},
			mariadb: {
				where: eq(mariadb.appName, appName),
				columns: { mariadbId: true },
			},
			mongo: {
				where: eq(mongo.appName, appName),
				columns: { mongoId: true },
			},
			mysql: {
				where: eq(mysql.appName, appName),
				columns: { mysqlId: true },
			},
			postgres: {
				where: eq(postgres.appName, appName),
				columns: { postgresId: true },
			},
			redis: {
				where: eq(redis.appName, appName),
				columns: { redisId: true },
			},
		},
	});

	// Filter out items with non-empty fields
	const nonEmptyProjects = query.filter(
		(project) =>
			project.applications.length > 0 ||
			project.libsql.length > 0 ||
			project.mariadb.length > 0 ||
			project.mongo.length > 0 ||
			project.mysql.length > 0 ||
			project.postgres.length > 0 ||
			project.redis.length > 0,
	);

	return nonEmptyProjects.length === 0;
};
