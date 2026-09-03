import type { InferResultType } from "@nomploy/server/types/with";
import { uploadImageRemoteCommand } from "../cluster/upload";
import { getDockerCommand } from "./docker-file";
import { getHerokuCommand } from "./heroku";
import { getNixpacksCommand } from "./nixpacks";
import { getPaketoCommand } from "./paketo";
import { getRailpackCommand } from "./railpack";
import { getStaticCommand } from "./static";

// NIXPACKS codeDirectory = where is the path of the code directory
// HEROKU codeDirectory = where is the path of the code directory
// PAKETO codeDirectory = where is the path of the code directory
// DOCKERFILE codeDirectory = where is the exact path of the (Dockerfile)
export type ApplicationNested = InferResultType<
	"applications",
	{
		mounts: true;
		security: true;
		redirects: true;
		ports: true;
		registry: true;
		buildRegistry: true;
		rollbackRegistry: true;
		deployments: true;
		environment: { with: { project: true } };
	}
>;

export const getBuildCommand = async (application: ApplicationNested) => {
	let command = "";

	if (application.sourceType !== "docker") {
		const { buildType } = application;
		switch (buildType) {
			case "nixpacks":
				command = getNixpacksCommand(application);
				break;
			case "heroku_buildpacks":
				command = getHerokuCommand(application);
				break;
			case "paketo_buildpacks":
				command = getPaketoCommand(application);
				break;
			case "static":
				command = getStaticCommand(application);
				break;
			case "dockerfile":
				command = getDockerCommand(application);
				break;
			case "railpack":
				command = getRailpackCommand(application);
				break;
		}
	}

	if (
		application.registry ||
		application.buildRegistry ||
		application.rollbackRegistry
	) {
		command += await uploadImageRemoteCommand(application);
	}

	return command;
};
