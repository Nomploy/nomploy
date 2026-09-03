import { db } from "@nomploy/server/db";
import {
	type apiCreateMySql,
	backups,
	buildAppName,
	mysql,
} from "@nomploy/server/db/schema";
import { generatePassword } from "@nomploy/server/templates";
import { deployDatabaseToNomad } from "@nomploy/server/utils/databases/nomad-deploy";
import { pullImage } from "@nomploy/server/utils/docker/utils";
import { execAsyncRemote } from "@nomploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq, getTableColumns } from "drizzle-orm";
import type { z } from "zod";
import { validUniqueServerAppName } from "./project";

export type MySql = typeof mysql.$inferSelect;

export const createMysql = async (input: z.infer<typeof apiCreateMySql>) => {
	const appName = buildAppName("mysql", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newMysql = await db
		.insert(mysql)
		.values({
			...input,
			databasePassword: input.databasePassword
				? input.databasePassword
				: generatePassword(),
			databaseRootPassword: input.databaseRootPassword
				? input.databaseRootPassword
				: generatePassword(),
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newMysql) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting mysql database",
		});
	}

	return newMysql;
};

// https://github.com/drizzle-team/drizzle-orm/discussions/1483#discussioncomment-7523881
export const findMySqlById = async (mysqlId: string) => {
	const result = await db.query.mysql.findFirst({
		where: eq(mysql.mysqlId, mysqlId),
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
			message: "MySql not found",
		});
	}
	return result;
};

export const updateMySqlById = async (
	mysqlId: string,
	mysqlData: Partial<MySql>,
) => {
	const { appName, ...rest } = mysqlData;
	const result = await db
		.update(mysql)
		.set({
			...rest,
		})
		.where(eq(mysql.mysqlId, mysqlId))
		.returning();

	return result[0];
};

export const findMySqlByBackupId = async (backupId: string) => {
	const result = await db
		.select({
			...getTableColumns(mysql),
		})
		.from(mysql)
		.innerJoin(backups, eq(mysql.mysqlId, backups.mysqlId))
		.where(eq(backups.backupId, backupId))
		.limit(1);

	if (!result || !result[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Mysql not found",
		});
	}
	return result[0];
};

export const removeMySqlById = async (mysqlId: string) => {
	const result = await db
		.delete(mysql)
		.where(eq(mysql.mysqlId, mysqlId))
		.returning();

	return result[0];
};

export const deployMySql = async (
	mysqlId: string,
	onData?: (data: any) => void,
) => {
	const mysql = await findMySqlById(mysqlId);
	try {
		await updateMySqlById(mysqlId, {
			applicationStatus: "running",
		});
		onData?.("Starting mysql deployment...");
		if (mysql.serverId) {
			await execAsyncRemote(
				mysql.serverId,
				`docker pull ${mysql.dockerImage}`,
				onData,
			);
		} else {
			await pullImage(mysql.dockerImage, onData);
		}

		await deployDatabaseToNomad(
			{
				appName: mysql.appName,
				image: mysql.dockerImage,
				containerPort: 3306,
				externalPort: mysql.externalPort,
				dataPath: "/var/lib/mysql",
				env:
					mysql.databaseUser !== "root"
						? `MYSQL_USER="${mysql.databaseUser}"\nMYSQL_DATABASE="${mysql.databaseName}"\nMYSQL_PASSWORD="${mysql.databasePassword}"\nMYSQL_ROOT_PASSWORD="${mysql.databaseRootPassword}"${mysql.env ? `\n${mysql.env}` : ""}`
						: `MYSQL_DATABASE="${mysql.databaseName}"\nMYSQL_ROOT_PASSWORD="${mysql.databaseRootPassword}"${mysql.env ? `\n${mysql.env}` : ""}`,
				projectEnv: mysql.environment.project.env,
				environmentEnv: mysql.environment.env,
				cpuLimit: mysql.cpuLimit,
				memoryLimit: mysql.memoryLimit,
				command: mysql.command,
				args: mysql.args,
				mounts: mysql.mounts,
			},
			mysql.serverId,
			onData,
		);
		await updateMySqlById(mysqlId, {
			applicationStatus: "done",
		});
		onData?.("Deployment completed successfully!");
	} catch (error) {
		onData?.(`Error: ${error}`);
		await updateMySqlById(mysqlId, {
			applicationStatus: "error",
		});
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Error on deploy mysql${error}`,
		});
	}
	return mysql;
};
