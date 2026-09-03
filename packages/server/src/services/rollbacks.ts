import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import {
	type createRollbackSchema,
	deployments as deploymentsSchema,
	rollbacks,
} from "../db/schema";
import {
	getBuildNomadApplicationCommand,
	NOMAD_APP_SERVICE_NAME,
} from "../utils/builders/nomad-application";
import { getRegistryTag } from "../utils/cluster/upload";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { findApplicationById } from "./application";
import { findDeploymentById } from "./deployment";

export const createRollback = async (
	input: z.infer<typeof createRollbackSchema>,
) => {
	return await db.transaction(async (tx) => {
		const { fullContext, ...other } = input;
		const rollback = await tx
			.insert(rollbacks)
			.values(other)
			.returning()
			.then((res) => res[0]);

		if (!rollback) {
			throw new Error("Failed to create rollback");
		}

		const tagImage = `${input.appName}:v${rollback.version}`;
		const deployment = await findDeploymentById(rollback.deploymentId);

		if (!deployment?.applicationId) {
			throw new Error("Deployment not found");
		}

		const {
			deployments: _,
			bitbucket,
			github,
			gitlab,
			gitea,
			...rest
		} = await findApplicationById(deployment.applicationId);

		await tx
			.update(rollbacks)
			.set({
				image: tagImage,
				fullContext: rest,
			})
			.where(eq(rollbacks.rollbackId, rollback.rollbackId));

		// Update the deployment to reference this rollback
		await tx
			.update(deploymentsSchema)
			.set({
				rollbackId: rollback.rollbackId,
			})
			.where(eq(deploymentsSchema.deploymentId, rollback.deploymentId));

		const updatedRollback = await tx.query.rollbacks.findFirst({
			where: eq(rollbacks.rollbackId, rollback.rollbackId),
		});

		return updatedRollback;
	});
};

export const findRollbackById = async (rollbackId: string) => {
	const result = await db.query.rollbacks.findFirst({
		where: eq(rollbacks.rollbackId, rollbackId),
		with: {
			deployment: {
				with: {
					application: {
						with: {
							environment: {
								with: {
									project: true,
								},
							},
						},
					},
				},
			},
		},
	});

	if (!result) {
		throw new Error("Rollback not found");
	}

	return result;
};

const deleteRollbackImage = async (image: string, serverId?: string | null) => {
	const command = `docker image rm ${image} --force`;

	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const removeRollbackById = async (rollbackId: string) => {
	const rollback = await findRollbackById(rollbackId);

	if (!rollback) {
		throw new Error("Rollback not found");
	}

	if (rollback?.image) {
		try {
			const deployment = await findDeploymentById(rollback.deploymentId);

			if (!deployment?.applicationId) {
				throw new Error("Deployment not found");
			}

			const application = await findApplicationById(deployment.applicationId);
			await deleteRollbackImage(rollback.image, application.serverId);

			await db
				.delete(rollbacks)
				.where(eq(rollbacks.rollbackId, rollbackId))
				.returning()
				.then((res) => res[0]);
		} catch (error) {
			console.error(error);
		}
	}

	return rollback;
};

export const rollback = async (rollbackId: string) => {
	const result = await findRollbackById(rollbackId);

	const deployment = await findDeploymentById(result.deploymentId);

	if (!deployment?.applicationId) {
		throw new Error("Deployment not found");
	}

	const application = await findApplicationById(deployment.applicationId);

	if (!result.fullContext) {
		throw new Error("Rollback context not found");
	}
	// Re-submit the application's Nomad job with the rollback image (already in the
	// registry) instead of recreating a Docker Swarm service.
	const rollbackImage = application.rollbackRegistry
		? getRegistryTag(application.rollbackRegistry, result.image || "")
		: result.image || "";
	const domains = (application.domains ?? []).map((d) => ({
		...d,
		serviceName: NOMAD_APP_SERVICE_NAME,
	}));
	const command = getBuildNomadApplicationCommand(
		application,
		domains,
		rollbackImage,
	);
	if (application.serverId) {
		await execAsyncRemote(application.serverId, command);
	} else {
		await execAsync(command);
	}
};
