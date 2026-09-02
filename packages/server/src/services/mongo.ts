import { db } from "@nomploy/server/db";
import {
	type apiCreateMongo,
	backups,
	buildAppName,
	compose,
	mongo,
} from "@nomploy/server/db/schema";
import { generatePassword } from "@nomploy/server/templates";
import { deployDatabaseToNomad } from "@nomploy/server/utils/databases/nomad-deploy";
import { pullImage } from "@nomploy/server/utils/docker/utils";
import { execAsyncRemote } from "@nomploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq, getTableColumns } from "drizzle-orm";
import type { z } from "zod";
import { validUniqueServerAppName } from "./project";

export type Mongo = typeof mongo.$inferSelect;

export const createMongo = async (input: z.infer<typeof apiCreateMongo>) => {
	const appName = buildAppName("mongo", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newMongo = await db
		.insert(mongo)
		.values({
			...input,
			databasePassword: input.databasePassword
				? input.databasePassword
				: generatePassword(),
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newMongo) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting mongo database",
		});
	}

	return newMongo;
};

export const findMongoById = async (mongoId: string) => {
	const result = await db.query.mongo.findFirst({
		where: eq(mongo.mongoId, mongoId),
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
			message: "Mongo not found",
		});
	}
	return result;
};

export const updateMongoById = async (
	mongoId: string,
	mongoData: Partial<Mongo>,
) => {
	const { appName, ...rest } = mongoData;
	const result = await db
		.update(mongo)
		.set({
			...rest,
		})
		.where(eq(mongo.mongoId, mongoId))
		.returning();

	return result[0];
};

export const findMongoByBackupId = async (backupId: string) => {
	const result = await db
		.select({
			...getTableColumns(mongo),
		})
		.from(mongo)
		.innerJoin(backups, eq(mongo.mongoId, backups.mongoId))
		.where(eq(backups.backupId, backupId))
		.limit(1);

	if (!result || !result[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Mongo not found",
		});
	}
	return result[0];
};

export const findComposeByBackupId = async (backupId: string) => {
	const result = await db
		.select({
			...getTableColumns(compose),
		})
		.from(compose)
		.innerJoin(backups, eq(compose.composeId, backups.composeId))
		.where(eq(backups.backupId, backupId))
		.limit(1);

	if (!result || !result[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result[0];
};

export const removeMongoById = async (mongoId: string) => {
	const result = await db
		.delete(mongo)
		.where(eq(mongo.mongoId, mongoId))
		.returning();

	return result[0];
};

export const deployMongo = async (
	mongoId: string,
	onData?: (data: any) => void,
) => {
	const mongo = await findMongoById(mongoId);
	try {
		await updateMongoById(mongoId, {
			applicationStatus: "running",
		});

		onData?.("Starting mongo deployment...");
		if (mongo.serverId) {
			await execAsyncRemote(
				mongo.serverId,
				`docker pull ${mongo.dockerImage}`,
				onData,
			);
		} else {
			await pullImage(mongo.dockerImage, onData);
		}

		await deployDatabaseToNomad(
			{
				appName: mongo.appName,
				image: mongo.dockerImage,
				containerPort: 27017,
				externalPort: mongo.externalPort,
				dataPath: "/data/db",
				env: `MONGO_INITDB_ROOT_USERNAME="${mongo.databaseUser}"\nMONGO_INITDB_ROOT_PASSWORD="${mongo.databasePassword}"${mongo.replicaSets ? "\nMONGO_INITDB_DATABASE=admin" : ""}${mongo.env ? `\n${mongo.env}` : ""}`,
				projectEnv: mongo.environment.project.env,
				environmentEnv: mongo.environment.env,
				cpuLimit: mongo.cpuLimit,
				memoryLimit: mongo.memoryLimit,
				command: mongo.command,
				args: mongo.args,
				mounts: mongo.mounts,
			},
			mongo.serverId,
			onData,
		);
		await updateMongoById(mongoId, {
			applicationStatus: "done",
		});
		onData?.("Deployment completed successfully!");
	} catch (error) {
		onData?.(`Error: ${error}`);
		await updateMongoById(mongoId, {
			applicationStatus: "error",
		});

		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Error on deploy mongo${error}`,
		});
	}
	return mongo;
};
