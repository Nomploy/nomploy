import { db } from "@nomploy/server/db";
import {
	type apiCreateLibsql,
	backups,
	buildAppName,
	libsql,
} from "@nomploy/server/db/schema";
import { generatePassword } from "@nomploy/server/templates";
import { deployDatabaseToNomad } from "@nomploy/server/utils/databases/nomad-deploy";
import { pullImage } from "@nomploy/server/utils/docker/utils";
import { execAsyncRemote } from "@nomploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq, getTableColumns } from "drizzle-orm";
import type { z } from "zod";
import { validUniqueServerAppName } from "./project";

export type Libsql = typeof libsql.$inferSelect;

export const createLibsql = async (input: z.infer<typeof apiCreateLibsql>) => {
	const appName = buildAppName("libsql", input.appName);

	const valid = await validUniqueServerAppName(input.appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newLibsql = await db
		.insert(libsql)
		.values({
			...input,
			databasePassword: input.databasePassword
				? input.databasePassword
				: generatePassword(),
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newLibsql) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting libsql database",
		});
	}

	return newLibsql;
};

// https://github.com/drizzle-team/drizzle-orm/discussions/1483#discussioncomment-7523881
export const findLibsqlById = async (libsqlId: string) => {
	const result = await db.query.libsql.findFirst({
		where: eq(libsql.libsqlId, libsqlId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			mounts: true,
			server: true,
			backups: {
				with: {
					destination: true,
					deployments: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Libsql not found",
		});
	}
	return result;
};

export const updateLibsqlById = async (
	libsqlId: string,
	libsqlData: Partial<Libsql>,
) => {
	const { appName, ...rest } = libsqlData;
	const result = await db
		.update(libsql)
		.set({
			...rest,
		})
		.where(eq(libsql.libsqlId, libsqlId))
		.returning();

	return result[0];
};

export const removeLibsqlById = async (libsqlId: string) => {
	const result = await db
		.delete(libsql)
		.where(eq(libsql.libsqlId, libsqlId))
		.returning();

	return result[0];
};

export const findLibsqlByBackupId = async (backupId: string) => {
	const result = await db
		.select({
			...getTableColumns(libsql),
		})
		.from(libsql)
		.innerJoin(backups, eq(libsql.libsqlId, backups.libsqlId))
		.where(eq(backups.backupId, backupId))
		.limit(1);

	if (!result || !result[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Libsql not found",
		});
	}
	return result[0];
};

export const deployLibsql = async (
	libsqlId: string,
	onData?: (data: any) => void,
) => {
	const libsql = await findLibsqlById(libsqlId);
	try {
		await updateLibsqlById(libsqlId, {
			applicationStatus: "running",
		});
		onData?.("Starting libsql deployment...");
		if (libsql.serverId) {
			await execAsyncRemote(
				libsql.serverId,
				`docker pull ${libsql.dockerImage}`,
				onData,
			);
		} else {
			await pullImage(libsql.dockerImage, onData);
		}

		{
			const basicAuth = Buffer.from(
				`${libsql.databaseUser}:${libsql.databasePassword}`,
				"utf-8",
			).toString("base64");
			await deployDatabaseToNomad(
				{
					appName: libsql.appName,
					image: libsql.dockerImage,
					containerPort: 8080,
					extraPorts: [5001],
					externalPort: libsql.externalPort,
					dataPath: "/var/lib/sqld",
					env: `SQLD_NODE="${libsql.sqldNode}"\nSQLD_HTTP_AUTH="basic:${basicAuth}"${libsql.env ? `\n${libsql.env}` : ""}${libsql.sqldNode === "replica" ? `\nSQLD_PRIMARY_URL="${libsql.sqldPrimaryUrl}"` : ""}`,
					projectEnv: libsql.environment.project.env,
					environmentEnv: libsql.environment.env,
					cpuLimit: libsql.cpuLimit,
					memoryLimit: libsql.memoryLimit,
					command: libsql.command,
					mounts: libsql.mounts,
				},
				libsql.serverId,
				onData,
			);
		}
		await updateLibsqlById(libsqlId, {
			applicationStatus: "done",
		});
		onData?.("Deployment completed successfully!");
	} catch (error) {
		onData?.(`Error: ${error}`);
		await updateLibsqlById(libsqlId, {
			applicationStatus: "error",
		});

		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Error on deploy libsql${error}`,
		});
	}
	return libsql;
};
