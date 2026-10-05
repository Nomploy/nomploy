import { join } from "node:path";
import { paths } from "@nomploy/server/constants";
import { db } from "@nomploy/server/db";
import {
	type apiCreateCompose,
	buildAppName,
	cleanAppName,
	compose,
} from "@nomploy/server/db/schema";
import {
	monitorNomadRollout,
	waitForRollout,
} from "@nomploy/server/setup/deploy-monitor";
import { syncIntentionsForOrg } from "@nomploy/server/setup/nomad-connect";
import type { PackMetaCtx } from "@nomploy/server/setup/pack-nomad";
import { getBuildComposeCommand } from "@nomploy/server/utils/builders/compose";
import {
	getBuildNomadCommand,
	getBuildNomadPackCommand,
	type NomadComposeNested,
	packRenderDir,
} from "@nomploy/server/utils/builders/nomad";
import { randomizeSpecificationFile } from "@nomploy/server/utils/docker/compose";
import {
	cloneCompose,
	loadDockerCompose,
	loadDockerComposeRemote,
} from "@nomploy/server/utils/docker/domain";
import type { ComposeSpecification } from "@nomploy/server/utils/docker/types";
import { sendBuildErrorNotifications } from "@nomploy/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@nomploy/server/utils/notifications/build-success";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@nomploy/server/utils/process/execAsync";
import { cloneBitbucketRepository } from "@nomploy/server/utils/providers/bitbucket";
import {
	cloneGitRepository,
	getGitCommitInfo,
} from "@nomploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@nomploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@nomploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@nomploy/server/utils/providers/gitlab";
import { getCreateComposeFileCommand } from "@nomploy/server/utils/providers/raw";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import { getNomployUrl } from "./admin";
import {
	createDeploymentCompose,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import { generateApplyPatchesCommand } from "./patch";
import { validUniqueServerAppName } from "./project";

export type Compose = typeof compose.$inferSelect;

/**
 * Nomad-Pack single registration. The deploy shell has already RENDERED the
 * pack's job files (nomad-pack render --to-dir); here we do the ONE Nomad
 * registration in TS — ingress tags + canary_tags/shutdown_delay and the panel's
 * scaling overrides folded into that single register (buildPackJobPatch), re-
 * stamping the pack.* meta so `nomad-pack destroy` still finds the jobs. Then we
 * wait for the rollout to go healthy (reusing the detached-path poller). This
 * replaces `nomad-pack run` + a post-deploy re-patch, which was TWO registrations
 * per deploy and broke canary (each register is its own canary transition →
 * consulCatalog 404 window). Throws on a definitive rollout failure so the deploy
 * is marked failed; warns-and-continues on timeout.
 */
const registerPackDeployment = async (
	entity: NomadComposeNested,
	logPath: string,
): Promise<void> => {
	const { registerRenderedPackJobs } = await import(
		"@nomploy/server/setup/pack-nomad"
	);
	const { buildPackJobPatch } = await import(
		"@nomploy/server/setup/pack-domains"
	);
	const meta: PackMetaCtx = {
		deploymentName: entity.appName,
		packName: (entity.nomadPack || "").trim(),
		registryName: entity.nomadPackRegistry ? "nomploy-custom" : "default",
		version: (entity.nomadPackRef || "").trim() || "latest",
	};
	const patch = await buildPackJobPatch(entity);
	const ids = await registerRenderedPackJobs(
		packRenderDir(entity),
		meta,
		patch,
	);
	const outcome = await waitForRollout(ids, 150_000);
	const line =
		outcome === "failed"
			? "Nomad Pack rollout FAILED ❌"
			: outcome === "ok"
				? "Nomad Pack rollout healthy ✅"
				: "Nomad Pack rollout not confirmed within the window (still in progress) — check the dashboard";
	const logCmd = `echo "${encodeBase64(`${line}\n`)}" | base64 -d >> ${logPath}`;
	try {
		if (entity.serverId) await execAsyncRemote(entity.serverId, logCmd);
		else await execAsync(logCmd);
	} catch {
		// best-effort log line
	}
	if (outcome === "failed") {
		throw new Error("Nomad Pack rollout did not become healthy");
	}
};

export const createCompose = async (
	input: z.infer<typeof apiCreateCompose>,
) => {
	const appName = buildAppName("compose", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			composeFile: input.composeFile || "",
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const createComposeByTemplate = async (
	input: typeof compose.$inferInsert,
) => {
	const appName = cleanAppName(input.appName);
	if (appName) {
		const valid = await validUniqueServerAppName(appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const findComposeById = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			deployments: true,
			mounts: true,
			domains: true,
			github: true,
			gitlab: true,
			bitbucket: true,
			gitea: true,
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
			message: "Compose not found",
		});
	}
	return result;
};

export const loadServices = async (
	composeId: string,
	type: "fetch" | "cache" = "fetch",
) => {
	const compose = await findComposeById(composeId);

	// Nomad Packs have no docker-compose file to parse — their "services" are the
	// Consul services their deployed jobs register. List those instead.
	if (compose.composeType === "nomad-pack") {
		const { loadPackServices } = await import(
			"@nomploy/server/setup/pack-domains"
		);
		return (await loadPackServices(compose.appName)).map((s) => s.name);
	}

	if (type === "fetch") {
		const command = await cloneCompose(compose);
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
	}

	let composeData: ComposeSpecification | null;

	if (compose.serverId) {
		composeData = await loadDockerComposeRemote(compose);
	} else {
		composeData = await loadDockerCompose(compose);
	}

	if (compose.randomize && composeData) {
		const randomizedCompose = randomizeSpecificationFile(
			composeData,
			compose.suffix,
		);
		composeData = randomizedCompose;
	}

	if (!composeData?.services) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Services not found",
		});
	}

	const services = Object.keys(composeData.services);

	return [...services];
};

export const updateCompose = async (
	composeId: string,
	composeData: Partial<Compose>,
) => {
	const { appName, ...rest } = composeData;
	const composeResult = await db
		.update(compose)
		.set({
			...rest,
		})
		.where(eq(compose.composeId, composeId))
		.returning();

	return composeResult[0];
};

export const deployCompose = async ({
	composeId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);

	const buildLink = `${await getNomployUrl()}/dashboard/project/${
		compose.environment.projectId
	}/environment/${compose.environmentId}/services/compose/${compose.composeId}?tab=deployments`;
	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		const entity = {
			...compose,
			type: "compose" as const,
		};
		let command = "set -e;";
		if (compose.composeType === "nomad-pack") {
			// A Nomad Pack fetches its source from the pack registry at deploy time
			// (nomad-pack run) — there's no git repo to clone. Skipping this avoids a
			// "Github Provider not found" failure, since a pack compose's sourceType
			// defaults to "github" with no provider configured.
		} else if (compose.sourceType === "github") {
			command += await cloneGithubRepository(entity);
		} else if (compose.sourceType === "gitlab") {
			command += await cloneGitlabRepository(entity);
		} else if (compose.sourceType === "bitbucket") {
			command += await cloneBitbucketRepository(entity);
		} else if (compose.sourceType === "git") {
			command += await cloneGitRepository(entity);
		} else if (compose.sourceType === "gitea") {
			command += await cloneGiteaRepository(entity);
		} else if (compose.sourceType === "raw") {
			command += getCreateComposeFileCommand(entity);
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}
		if (compose.sourceType !== "raw" && compose.composeType !== "nomad-pack") {
			command = "set -e;";
			command += await generateApplyPatchesCommand({
				id: compose.composeId,
				type: "compose",
				serverId: compose.serverId,
			});
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		}

		// Pin the pack to a concrete registry ref on first deploy so redeploys are
		// reproducible (else nomad-pack pulls the registry HEAD every time). Upgrades
		// bump this explicitly via the upgradePack action (with a rendered diff).
		if (compose.composeType === "nomad-pack" && !compose.nomadPackRef) {
			const { resolvePackHeadRef } = await import(
				"@nomploy/server/setup/pack-version"
			);
			const ref = await resolvePackHeadRef(compose).catch(() => null);
			if (ref) {
				await updateCompose(composeId, { nomadPackRef: ref });
				entity.nomadPackRef = ref;
			}
		}

		command = "set -e;";
		if (compose.composeType === "nomad-pack") {
			command += getBuildNomadPackCommand(entity);
		} else if (compose.composeType === "nomad") {
			// Detached: register now, watch the rollout off the deployment queue.
			command += await getBuildNomadCommand(entity, { detach: true });
		} else {
			command += await getBuildComposeCommand(entity);
		}
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		// Nomad-Pack: the shell only RENDERED the pack; do the single Nomad
		// registration (ingress + scaling folded in) and wait for health in TS.
		if (compose.composeType === "nomad-pack") {
			await registerPackDeployment(entity, deployment.logPath);
		}

		const finalizeSuccess = async () => {
			await updateDeploymentStatus(deployment.deploymentId, "done");
			// Phase B: refresh Connect intentions so this project's mesh services
			// (isolated) get their allow-rules; no-op for non-isolated orgs.
			if (compose.environment.project.isolated) {
				await syncIntentionsForOrg(
					compose.environment.project.organizationId,
				).catch(() => {});
			}
			await updateCompose(composeId, {
				composeStatus: "done",
			});

			await sendBuildSuccessNotifications({
				projectName: compose.environment.project.name,
				applicationName: compose.name,
				applicationType: "compose",
				buildLink,
				organizationId: compose.environment.project.organizationId,
				domains: compose.domains,
				environmentName: compose.environment.name,
			});
		};

		if (compose.composeType === "nomad") {
			// Registration succeeded; watch the rollout OFF the deployment queue so a slow
			// or stuck rollout can't block other orgs' deploys (queue concurrency 1). The
			// monitor finalizes status + notification once Nomad is terminal.
			monitorNomadRollout({
				appName: compose.appName,
				mode: "job",
				serverId: compose.serverId,
				logPath: deployment.logPath,
				onSuccess: finalizeSuccess,
				onFailure: async (reason) => {
					await updateDeploymentStatus(deployment.deploymentId, "error");
					await updateCompose(composeId, { composeStatus: "error" });
					await sendBuildErrorNotifications({
						projectName: compose.environment.project.name,
						applicationName: compose.name,
						applicationType: "compose",
						errorMessage: reason,
						buildLink,
						organizationId: compose.environment.project.organizationId,
					});
				},
			});
		} else {
			// Pack / docker-compose: finalize synchronously (behavior unchanged).
			await finalizeSuccess();
		}
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		await sendBuildErrorNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			// @ts-ignore
			errorMessage: error?.message || "Error building",
			buildLink,
			organizationId: compose.environment.project.organizationId,
		});
		throw error;
	} finally {
		if (compose.sourceType !== "raw" && compose.composeType !== "nomad-pack") {
			const commitInfo = await getGitCommitInfo({
				...compose,
				type: "compose",
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
};

export const rebuildCompose = async ({
	composeId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);

	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		let command = "set -e;";
		if (compose.sourceType === "raw") {
			command += getCreateComposeFileCommand(compose);
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		if (compose.sourceType !== "raw" && compose.composeType !== "nomad-pack") {
			command = "set -e;";
			command += await generateApplyPatchesCommand({
				id: compose.composeId,
				type: "compose",
				serverId: compose.serverId,
			});
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		}

		command = "set -e;";
		if (compose.composeType === "nomad-pack") {
			command += getBuildNomadPackCommand(compose);
		} else if (compose.composeType === "nomad") {
			// Detached: register now, watch the rollout off the deployment queue.
			command += await getBuildNomadCommand(compose, { detach: true });
		} else {
			command += await getBuildComposeCommand(compose);
		}
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		// Nomad-Pack: the shell only RENDERED the pack; do the single Nomad
		// registration (ingress + scaling folded in) and wait for health in TS.
		if (compose.composeType === "nomad-pack") {
			await registerPackDeployment(compose, deployment.logPath);
		}

		const finalizeSuccess = async () => {
			await updateDeploymentStatus(deployment.deploymentId, "done");
			// Phase B: refresh Connect intentions so this project's mesh services
			// (isolated) get their allow-rules; no-op for non-isolated orgs.
			if (compose.environment.project.isolated) {
				await syncIntentionsForOrg(
					compose.environment.project.organizationId,
				).catch(() => {});
			}
			await updateCompose(composeId, {
				composeStatus: "done",
			});
		};

		if (compose.composeType === "nomad") {
			// Registration succeeded; watch the rollout OFF the deployment queue (see
			// deployCompose) so a slow/stuck rollout can't block other deploys.
			monitorNomadRollout({
				appName: compose.appName,
				mode: "job",
				serverId: compose.serverId,
				logPath: deployment.logPath,
				onSuccess: finalizeSuccess,
				onFailure: async () => {
					await updateDeploymentStatus(deployment.deploymentId, "error");
					await updateCompose(composeId, { composeStatus: "error" });
				},
			});
		} else {
			// Pack / docker-compose: finalize synchronously (behavior unchanged).
			await finalizeSuccess();
		}
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};

export const removeCompose = async (
	compose: Compose,
	deleteVolumes: boolean,
) => {
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		const projectPath = join(COMPOSE_PATH, compose.appName);

		if (
			compose.composeType === "nomad" ||
			compose.composeType === "nomad-pack"
		) {
			// Tear down the Nomad job (native/compose = purge by appName; a pack =
			// nomad-pack destroy, since its jobs aren't named after appName).
			const teardown =
				compose.composeType === "nomad-pack" && compose.nomadPack
					? `nomad-pack destroy ${compose.nomadPack}${
							compose.nomadPackRegistry ? " --registry nomploy-custom" : ""
						} --name "${compose.appName}" 2>&1 || true`
					: `nomad job stop -purge ${compose.appName} || true`;
			const command = `
			${teardown};
			rm -rf ${projectPath}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		} else {
			const command = `
			docker network disconnect ${compose.appName} nomploy-traefik;
			env -i PATH="$PATH" docker compose -p ${compose.appName} down ${
				deleteVolumes ? "--volumes" : ""
			};
			rm -rf ${projectPath}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		throw error;
	}

	return true;
};

export const startCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);

		const projectPath = join(COMPOSE_PATH, compose.appName, "code");
		const path =
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
		const baseCommand = `env -i PATH="$PATH" docker compose -p ${compose.appName} -f ${path} up -d`;
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${projectPath} && ${baseCommand}`,
				);
			} else {
				await execAsync(baseCommand, {
					cwd: projectPath,
				});
			}
		}

		if (compose.composeType === "nomad") {
			const jobFile = join(projectPath, `${compose.appName}.nomad.hcl`);
			const cmd = `nomad job run "${jobFile}"`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, cmd);
			} else {
				await execAsync(cmd);
			}
		}

		if (compose.composeType === "nomad-pack" && compose.nomadPack) {
			// Re-run the pack, reusing the var-file written at last deploy if present.
			const varFile = join(projectPath, `${compose.appName}.vars.hcl`);
			const registryFlag = compose.nomadPackRegistry
				? " --registry nomploy-custom"
				: "";
			const cmd = `VF=""; [ -f "${varFile}" ] && VF="--var-file=${varFile}"; nomad-pack run ${compose.nomadPack}${registryFlag} $VF --name "${compose.appName}" 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, cmd);
			} else {
				await execAsync(cmd);
			}
			// Route the pack's domains via a Traefik file-provider config.
			const { applyPackJobPatches } = await import(
				"@nomploy/server/setup/pack-domains"
			);
			// Domains + scaling (count/resources/autoscaling) in one re-registration.
			await applyPackJobPatches(compose).catch((e) =>
				console.error("pack job patches failed:", e),
			);
		}

		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "idle",
		});
		throw error;
	}

	return true;
};

export const stopCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${join(COMPOSE_PATH, compose.appName)} && env -i PATH="$PATH" docker compose -p ${
						compose.appName
					} stop`,
				);
			} else {
				await execAsync(
					`env -i PATH="$PATH" docker compose -p ${compose.appName} stop`,
					{
						cwd: join(COMPOSE_PATH, compose.appName),
					},
				);
			}
		}

		if (compose.composeType === "nomad") {
			const stopCmd = `nomad job stop ${compose.appName}`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, stopCmd);
			} else {
				await execAsync(stopCmd);
			}
		}

		if (compose.composeType === "nomad-pack" && compose.nomadPack) {
			// A pack's jobs aren't named after appName, so `nomad job stop` won't
			// match — tear the deployment down with `nomad-pack destroy` (by the
			// --name we deployed it under). Re-deploy re-runs it.
			// Ensure the custom registry alias exists before destroy (it may not,
			// e.g. after a control-plane rebuild). Registry values are charset-
			// validated at the schema, so interpolation here is safe.
			const regAdd = compose.nomadPackRegistry
				? `nomad-pack registry add nomploy-custom "${compose.nomadPackRegistry}" 2>&1 || true; `
				: "";
			const registryFlag = compose.nomadPackRegistry
				? " --registry nomploy-custom"
				: "";
			const stopCmd = `${regAdd}nomad-pack destroy ${compose.nomadPack}${registryFlag} --name "${compose.appName}" 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, stopCmd);
			} else {
				await execAsync(stopCmd);
			}
			// Remove the pack's Traefik domain routing (service is gone now).
			const { applyPackDomains } = await import(
				"@nomploy/server/setup/pack-domains"
			);
			await applyPackDomains({ ...compose, domains: [] }).catch((e) =>
				console.error("pack domains removal failed:", e),
			);
		}

		await updateCompose(composeId, {
			composeStatus: "idle",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};
