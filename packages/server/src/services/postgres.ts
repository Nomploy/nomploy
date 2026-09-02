import { db } from "@nomploy/server/db";
import {
	type apiCreatePostgres,
	backups,
	buildAppName,
	postgres,
} from "@nomploy/server/db/schema";
import { generatePassword } from "@nomploy/server/templates";
import {
	getBuildNomadDatabaseCommand,
	type NomadDatabaseInput,
} from "@nomploy/server/utils/builders/nomad-database";
import { pullImage } from "@nomploy/server/utils/docker/utils";
import {
	execAsync,
	execAsyncRemote,
} from "@nomploy/server/utils/process/execAsync";

// Resolve the Nomad client node name a database must be pinned to (its data lives
// in a node-local volume). Control-plane databases pin to the hub's node; a
// server-scoped database pins to that server's node.
const resolveNomadNodeName = async (
	serverId?: string | null,
): Promise<string> => {
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			"curl -s http://127.0.0.1:4646/v1/agent/self",
		);
		return JSON.parse(stdout).member.Name;
	}
	const addr = process.env.NOMAD_ADDRESS || "http://127.0.0.1:4646";
	const res = await fetch(`${addr}/v1/agent/self`);
	return ((await res.json()) as { member: { Name: string } }).member.Name;
};

import { TRPCError } from "@trpc/server";
import { eq, getTableColumns } from "drizzle-orm";
import type { z } from "zod";
import { validUniqueServerAppName } from "./project";

export function getMountPath(dockerImage: string): string {
	const versionMatch = dockerImage.match(/postgres:(\d+)/);

	if (versionMatch?.[1]) {
		const version = Number.parseInt(versionMatch[1], 10);
		if (version >= 18) {
			// PostgreSQL 18+ uses /var/lib/postgresql/{version}/docker as the default PGDATA
			return `/var/lib/postgresql/${version}/docker`;
		}
	}
	return "/var/lib/postgresql/data";
}

export type Postgres = typeof postgres.$inferSelect;

export const createPostgres = async (
	input: z.infer<typeof apiCreatePostgres>,
) => {
	const appName = buildAppName("postgres", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newPostgres = await db
		.insert(postgres)
		.values({
			...input,
			databasePassword: input.databasePassword
				? input.databasePassword
				: generatePassword(),
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newPostgres) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting postgresql database",
		});
	}

	return newPostgres;
};
export const findPostgresById = async (postgresId: string) => {
	const result = await db.query.postgres.findFirst({
		where: eq(postgres.postgresId, postgresId),
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
			message: "Postgres not found",
		});
	}
	return result;
};

export const findPostgresByBackupId = async (backupId: string) => {
	const result = await db
		.select({
			...getTableColumns(postgres),
		})
		.from(postgres)
		.innerJoin(backups, eq(postgres.postgresId, backups.postgresId))
		.where(eq(backups.backupId, backupId))
		.limit(1);

	if (!result || !result[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Postgres not found",
		});
	}
	return result[0];
};

export const updatePostgresById = async (
	postgresId: string,
	postgresData: Partial<Postgres>,
) => {
	const { appName, ...rest } = postgresData;
	const result = await db
		.update(postgres)
		.set({
			...rest,
		})
		.where(eq(postgres.postgresId, postgresId))
		.returning();

	return result[0];
};

export const removePostgresById = async (postgresId: string) => {
	const result = await db
		.delete(postgres)
		.where(eq(postgres.postgresId, postgresId))
		.returning();

	return result[0];
};

export const deployPostgres = async (
	postgresId: string,
	onData?: (data: any) => void,
) => {
	const postgres = await findPostgresById(postgresId);
	try {
		await updatePostgresById(postgresId, {
			applicationStatus: "running",
		});

		onData?.("Starting postgres deployment...");

		if (postgres.serverId) {
			await execAsyncRemote(
				postgres.serverId,
				`docker pull ${postgres.dockerImage}`,
				onData,
			);
		} else {
			await pullImage(postgres.dockerImage, onData);
		}

		// Deploy to Nomad instead of a Docker Swarm service.
		const targetNodeName = await resolveNomadNodeName(postgres.serverId);
		const input: NomadDatabaseInput = {
			appName: postgres.appName,
			image: postgres.dockerImage,
			containerPort: 5432,
			externalPort: postgres.externalPort,
			dataPath: getMountPath(postgres.dockerImage),
			env: `POSTGRES_DB="${postgres.databaseName}"\nPOSTGRES_USER="${postgres.databaseUser}"\nPOSTGRES_PASSWORD="${postgres.databasePassword}"${
				postgres.env ? `\n${postgres.env}` : ""
			}`,
			projectEnv: postgres.environment.project.env,
			environmentEnv: postgres.environment.env,
			cpuLimit: postgres.cpuLimit,
			memoryLimit: postgres.memoryLimit,
			command: postgres.command,
			args: postgres.args,
			targetNodeName,
			mounts: postgres.mounts,
		};
		const command = getBuildNomadDatabaseCommand(input);
		if (postgres.serverId) {
			await execAsyncRemote(postgres.serverId, command, onData);
		} else {
			const { stdout } = await execAsync(command);
			onData?.(stdout);
		}

		await updatePostgresById(postgresId, {
			applicationStatus: "done",
		});

		onData?.("Deployment completed successfully!");
	} catch (error) {
		onData?.(`Error: ${error}`);
		await updatePostgresById(postgresId, {
			applicationStatus: "error",
		});
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Error on deploy postgres${error}`,
		});
	}
	return postgres;
};
