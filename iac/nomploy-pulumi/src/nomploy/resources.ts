// Pulumi dynamic-provider resources for nomploy, built directly on the REST API.
//
// Each resource carries its own `endpoint` + `apiKey` (a dynamic provider is
// serialized into state, so connection details travel as resource inputs rather
// than ambient config). `apiKey` is kept out of the state file via
// `additionalSecretOutputs`.

import * as pulumi from "@pulumi/pulumi";
import { type Conn, call } from "./client";

// ─── shared helpers ──────────────────────────────────────────────────────────

const connOf = (props: any): Conn => ({
	endpoint: props.endpoint,
	apiKey: props.apiKey,
});

/** Did any of the given non-connection keys change? */
const changed = (olds: any, news: any, keys: string[]): boolean =>
	keys.some((k) => JSON.stringify(olds[k]) !== JSON.stringify(news[k]));

// ─── Project ─────────────────────────────────────────────────────────────────

export interface ProjectArgs {
	endpoint: pulumi.Input<string>;
	apiKey: pulumi.Input<string>;
	name: pulumi.Input<string>;
	description?: pulumi.Input<string>;
	env?: pulumi.Input<string>;
}

const projectProvider: pulumi.dynamic.ResourceProvider = {
	async create(inputs) {
		const r = await call(
			connOf(inputs),
			"project.create",
			{ name: inputs.name, description: inputs.description, env: inputs.env },
			"POST",
		);
		const projectId: string = r.project.projectId;
		const environmentId: string | undefined = r.environment?.environmentId;
		return { id: projectId, outs: { ...inputs, projectId, environmentId } };
	},
	async read(id, props) {
		const r = await call(connOf(props), "project.one", { projectId: id }, "GET");
		return {
			id,
			props: {
				...props,
				projectId: id,
				name: r?.name ?? props.name,
				description: r?.description ?? props.description,
			},
		};
	},
	async diff(_id, olds, news) {
		return {
			changes: changed(olds, news, ["name", "description", "env"]),
			replaces: [],
		};
	},
	async update(id, _olds, news) {
		await call(
			connOf(news),
			"project.update",
			{
				projectId: id,
				name: news.name,
				description: news.description,
				env: news.env,
			},
			"POST",
		);
		return { outs: { ...news, projectId: id } };
	},
	async delete(id, props) {
		await call(connOf(props), "project.remove", { projectId: id }, "POST");
	},
};

export class Project extends pulumi.dynamic.Resource {
	public readonly projectId!: pulumi.Output<string>;
	/** The auto-created production environment — pass this to Application/Database. */
	public readonly environmentId!: pulumi.Output<string>;
	constructor(
		name: string,
		args: ProjectArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			projectProvider,
			name,
			{ projectId: undefined, environmentId: undefined, ...args },
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
	}
}

// ─── Application ─────────────────────────────────────────────────────────────

export interface ApplicationArgs {
	endpoint: pulumi.Input<string>;
	apiKey: pulumi.Input<string>;
	name: pulumi.Input<string>;
	environmentId: pulumi.Input<string>;
	appName?: pulumi.Input<string>;
	description?: pulumi.Input<string>;
	serverId?: pulumi.Input<string>;
	/** Run a prebuilt image (sets the Docker source via application.saveDockerProvider). */
	dockerImage?: pulumi.Input<string>;
	/** Private registry for `dockerImage` (omit for public images). */
	registryUrl?: pulumi.Input<string>;
	registryUsername?: pulumi.Input<string>;
	registryPassword?: pulumi.Input<string>;
	/** Build from a generic git repo (application.saveGitProvider + saveBuildType). */
	gitUrl?: pulumi.Input<string>;
	gitBranch?: pulumi.Input<string>;
	gitBuildPath?: pulumi.Input<string>;
	/** SSH key id for a private repo (from the panel's SSH keys). */
	gitSshKeyId?: pulumi.Input<string>;
	/** Build type for a git source (default "nixpacks"). */
	buildType?: pulumi.Input<string>;
	dockerfile?: pulumi.Input<string>;
	dockerContextPath?: pulumi.Input<string>;
	/** Deploy on create, and redeploy whenever the image/source changes. */
	deploy?: pulumi.Input<boolean>;
}

const APP_SOURCE_KEYS = [
	"dockerImage",
	"registryUrl",
	"registryUsername",
	"registryPassword",
	"gitUrl",
	"gitBranch",
	"gitBuildPath",
	"gitSshKeyId",
	"buildType",
	"dockerfile",
	"dockerContextPath",
];

/** Push the configured source (Docker image OR generic git) for an application. */
async function applyAppSource(conn: Conn, applicationId: string, p: any) {
	if (p.dockerImage) {
		await call(
			conn,
			"application.saveDockerProvider",
			{
				applicationId,
				dockerImage: p.dockerImage,
				username: p.registryUsername ?? null,
				password: p.registryPassword ?? null,
				registryUrl: p.registryUrl ?? null,
			},
			"POST",
		);
		return;
	}
	if (p.gitUrl) {
		await call(
			conn,
			"application.saveGitProvider",
			{
				applicationId,
				customGitUrl: p.gitUrl,
				customGitBranch: p.gitBranch ?? "main",
				customGitBuildPath: p.gitBuildPath ?? "/",
				customGitSSHKeyId: p.gitSshKeyId ?? null,
				watchPaths: null,
				enableSubmodules: false,
			},
			"POST",
		);
		await call(
			conn,
			"application.saveBuildType",
			{
				applicationId,
				buildType: p.buildType ?? "nixpacks",
				dockerfile: p.dockerfile ?? null,
				dockerContextPath: p.dockerContextPath ?? null,
				dockerBuildStage: null,
				herokuVersion: null,
				railpackVersion: null,
				publishDirectory: null,
				isStaticSpa: null,
			},
			"POST",
		);
	}
}

const applicationProvider: pulumi.dynamic.ResourceProvider = {
	async create(inputs) {
		const conn = connOf(inputs);
		const r = await call(
			conn,
			"application.create",
			{
				name: inputs.name,
				appName: inputs.appName,
				description: inputs.description,
				environmentId: inputs.environmentId,
				serverId: inputs.serverId,
			},
			"POST",
		);
		const applicationId: string = r.applicationId;
		await applyAppSource(conn, applicationId, inputs);
		if (inputs.deploy) {
			await call(
				conn,
				"application.deploy",
				{ applicationId, title: "Pulumi deploy" },
				"POST",
			);
		}
		return {
			id: applicationId,
			outs: { ...inputs, applicationId, appName: r.appName },
		};
	},
	async read(id, props) {
		const r = await call(
			connOf(props),
			"application.one",
			{ applicationId: id },
			"GET",
		);
		return {
			id,
			props: {
				...props,
				applicationId: id,
				name: r?.name ?? props.name,
				appName: r?.appName ?? props.appName,
			},
		};
	},
	async diff(_id, olds, news) {
		return {
			changes: changed(olds, news, [
				"name",
				"description",
				"deploy",
				...APP_SOURCE_KEYS,
			]),
			// environmentId / appName are fixed at create → changing them replaces.
			replaces: changed(olds, news, ["environmentId", "appName"])
				? ["environmentId", "appName"]
				: [],
			deleteBeforeReplace: true,
		};
	},
	async update(id, olds, news) {
		const conn = connOf(news);
		await call(
			conn,
			"application.update",
			{ applicationId: id, name: news.name, description: news.description },
			"POST",
		);
		const sourceChanged = changed(olds, news, APP_SOURCE_KEYS);
		if (sourceChanged) await applyAppSource(conn, id, news);
		// Redeploy when the source changed (new image), if deploy is on.
		if (news.deploy && sourceChanged) {
			await call(
				conn,
				"application.deploy",
				{ applicationId: id, title: "Pulumi redeploy" },
				"POST",
			);
		}
		return { outs: { ...news, applicationId: id } };
	},
	async delete(id, props) {
		await call(connOf(props), "application.delete", { applicationId: id }, "POST");
	},
};

export class Application extends pulumi.dynamic.Resource {
	public readonly applicationId!: pulumi.Output<string>;
	public readonly appName!: pulumi.Output<string>;
	constructor(
		name: string,
		args: ApplicationArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			applicationProvider,
			name,
			{ applicationId: undefined, appName: undefined, ...args },
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
	}
}

// ─── Domain ──────────────────────────────────────────────────────────────────

export interface DomainArgs {
	endpoint: pulumi.Input<string>;
	apiKey: pulumi.Input<string>;
	host: pulumi.Input<string>;
	applicationId?: pulumi.Input<string>;
	composeId?: pulumi.Input<string>;
	port?: pulumi.Input<number>;
	https?: pulumi.Input<boolean>;
	path?: pulumi.Input<string>;
	serviceName?: pulumi.Input<string>;
	certificateType?: pulumi.Input<string>;
	domainType?: pulumi.Input<string>;
}

const DOMAIN_FIELDS = [
	"host",
	"port",
	"https",
	"path",
	"serviceName",
	"certificateType",
	"domainType",
];

const domainProvider: pulumi.dynamic.ResourceProvider = {
	async create(inputs) {
		const r = await call(
			connOf(inputs),
			"domain.create",
			{
				host: inputs.host,
				applicationId: inputs.applicationId,
				composeId: inputs.composeId,
				port: inputs.port,
				https: inputs.https,
				path: inputs.path,
				serviceName: inputs.serviceName,
				certificateType: inputs.certificateType,
				domainType: inputs.domainType,
			},
			"POST",
		);
		return { id: r.domainId, outs: { ...inputs, domainId: r.domainId } };
	},
	async read(id, props) {
		const r = await call(connOf(props), "domain.one", { domainId: id }, "GET");
		return { id, props: { ...props, domainId: id, host: r?.host ?? props.host } };
	},
	async diff(_id, olds, news) {
		return {
			changes: changed(olds, news, DOMAIN_FIELDS),
			// linking a domain to a different service replaces it.
			replaces: changed(olds, news, ["applicationId", "composeId"])
				? ["applicationId", "composeId"]
				: [],
			deleteBeforeReplace: true,
		};
	},
	async update(id, _olds, news) {
		await call(
			connOf(news),
			"domain.update",
			{
				domainId: id,
				host: news.host,
				port: news.port,
				https: news.https,
				path: news.path,
				serviceName: news.serviceName,
				certificateType: news.certificateType,
				domainType: news.domainType,
			},
			"POST",
		);
		return { outs: { ...news, domainId: id } };
	},
	async delete(id, props) {
		await call(connOf(props), "domain.delete", { domainId: id }, "POST");
	},
};

export class Domain extends pulumi.dynamic.Resource {
	public readonly domainId!: pulumi.Output<string>;
	constructor(
		name: string,
		args: DomainArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			domainProvider,
			name,
			{ domainId: undefined, ...args },
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
	}
}

// ─── Databases (postgres / mysql / mariadb / mongo / redis) ───────────────────
// All five engines share the same router verb set (create/one/update/remove/deploy)
// and a `<engine>Id` key, so one provider handles them all, parameterised by `engine`.

export type DatabaseEngine =
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis";

export interface DatabaseArgs {
	endpoint: pulumi.Input<string>;
	apiKey: pulumi.Input<string>;
	engine: pulumi.Input<DatabaseEngine>;
	name: pulumi.Input<string>;
	environmentId: pulumi.Input<string>;
	appName?: pulumi.Input<string>;
	description?: pulumi.Input<string>;
	serverId?: pulumi.Input<string>;
	dockerImage?: pulumi.Input<string>;
	databaseName?: pulumi.Input<string>;
	databaseUser?: pulumi.Input<string>;
	databasePassword?: pulumi.Input<string>;
	/** mysql / mariadb only. */
	databaseRootPassword?: pulumi.Input<string>;
	/** mongo only. */
	replicaSets?: pulumi.Input<boolean>;
	/** Deploy on create, and redeploy when config changes. */
	deploy?: pulumi.Input<boolean>;
}

// Fields forwarded to <engine>.create / .update (extras are stripped by the API's
// per-engine zod schema, so one superset is safe for all five).
const DB_FIELDS = [
	"name",
	"appName",
	"description",
	"serverId",
	"dockerImage",
	"databaseName",
	"databaseUser",
	"databasePassword",
	"databaseRootPassword",
	"replicaSets",
];

const dbBody = (p: any): Record<string, unknown> => {
	const body: Record<string, unknown> = {};
	for (const k of DB_FIELDS) if (p[k] !== undefined) body[k] = p[k];
	return body;
};

const databaseProvider: pulumi.dynamic.ResourceProvider = {
	async create(inputs) {
		const conn = connOf(inputs);
		const engine: DatabaseEngine = inputs.engine;
		const idKey = `${engine}Id`;
		const r = await call(
			conn,
			`${engine}.create`,
			{ ...dbBody(inputs), environmentId: inputs.environmentId },
			"POST",
		);
		const id: string = r[idKey];
		if (inputs.deploy) {
			await call(conn, `${engine}.deploy`, { [idKey]: id }, "POST");
		}
		return { id, outs: { ...inputs, databaseId: id, appName: r.appName } };
	},
	async read(id, props) {
		const engine: DatabaseEngine = props.engine;
		const r = await call(
			connOf(props),
			`${engine}.one`,
			{ [`${engine}Id`]: id },
			"GET",
		);
		return {
			id,
			props: { ...props, databaseId: id, name: r?.name ?? props.name },
		};
	},
	async diff(_id, olds, news) {
		return {
			changes: changed(olds, news, [...DB_FIELDS, "deploy"]),
			// engine / environmentId / appName are fixed at create → replace.
			replaces: changed(olds, news, ["engine", "environmentId", "appName"])
				? ["engine", "environmentId", "appName"]
				: [],
			deleteBeforeReplace: true,
		};
	},
	async update(id, olds, news) {
		const conn = connOf(news);
		const engine: DatabaseEngine = news.engine;
		const idKey = `${engine}Id`;
		await call(
			conn,
			`${engine}.update`,
			{ [idKey]: id, ...dbBody(news) },
			"POST",
		);
		if (news.deploy && changed(olds, news, DB_FIELDS)) {
			await call(conn, `${engine}.deploy`, { [idKey]: id }, "POST");
		}
		return { outs: { ...news, databaseId: id } };
	},
	async delete(id, props) {
		const engine: DatabaseEngine = props.engine;
		await call(connOf(props), `${engine}.remove`, { [`${engine}Id`]: id }, "POST");
	},
};

export class Database extends pulumi.dynamic.Resource {
	/** The engine-specific id (postgresId / mysqlId / …). */
	public readonly databaseId!: pulumi.Output<string>;
	public readonly appName!: pulumi.Output<string>;
	constructor(
		name: string,
		args: DatabaseArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			databaseProvider,
			name,
			{ databaseId: undefined, appName: undefined, ...args },
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
	}
}

// Convenience subclasses that pin the engine.
type DbArgs = Omit<DatabaseArgs, "engine">;
const dbClass = (engine: DatabaseEngine) =>
	class extends Database {
		constructor(name: string, args: DbArgs, opts?: pulumi.CustomResourceOptions) {
			super(name, { ...args, engine }, opts);
		}
	};

export const Postgres = dbClass("postgres");
export const Mysql = dbClass("mysql");
export const Mariadb = dbClass("mariadb");
export const Mongo = dbClass("mongo");
export const Redis = dbClass("redis");

// ─── Compose ──────────────────────────────────────────────────────────────────
// A compose service: a raw compose file (translated to a Nomad job) or a Nomad Pack.

export interface ComposeArgs {
	endpoint: pulumi.Input<string>;
	apiKey: pulumi.Input<string>;
	name: pulumi.Input<string>;
	environmentId: pulumi.Input<string>;
	appName?: pulumi.Input<string>;
	description?: pulumi.Input<string>;
	serverId?: pulumi.Input<string>;
	/** "nomad" (compose→Nomad, default) or "nomad-pack". */
	composeType?: pulumi.Input<"nomad" | "nomad-pack">;
	/** Raw compose YAML (composeType "nomad"). */
	composeFile?: pulumi.Input<string>;
	/** Pack name + git registry (composeType "nomad-pack"). */
	nomadPack?: pulumi.Input<string>;
	nomadPackRegistry?: pulumi.Input<string>;
	/** Remove volumes when the resource is destroyed (default false — keeps data). */
	deleteVolumesOnDestroy?: pulumi.Input<boolean>;
	/** Deploy on create, and redeploy when the compose file / pack changes. */
	deploy?: pulumi.Input<boolean>;
}

const COMPOSE_FIELDS = [
	"name",
	"description",
	"composeType",
	"composeFile",
	"nomadPack",
	"nomadPackRegistry",
];

const composeBody = (p: any): Record<string, unknown> => {
	const body: Record<string, unknown> = {
		composeType: p.composeType ?? (p.nomadPack ? "nomad-pack" : "nomad"),
	};
	for (const k of ["name", "description", "appName", "serverId", ...COMPOSE_FIELDS])
		if (p[k] !== undefined) body[k] = p[k];
	return body;
};

const composeProvider: pulumi.dynamic.ResourceProvider = {
	async create(inputs) {
		const conn = connOf(inputs);
		const r = await call(
			conn,
			"compose.create",
			{ ...composeBody(inputs), environmentId: inputs.environmentId },
			"POST",
		);
		const composeId: string = r.composeId;
		if (inputs.deploy) {
			await call(
				conn,
				"compose.deploy",
				{ composeId, title: "Pulumi deploy" },
				"POST",
			);
		}
		return { id: composeId, outs: { ...inputs, composeId, appName: r.appName } };
	},
	async read(id, props) {
		const r = await call(connOf(props), "compose.one", { composeId: id }, "GET");
		return { id, props: { ...props, composeId: id, name: r?.name ?? props.name } };
	},
	async diff(_id, olds, news) {
		return {
			changes: changed(olds, news, [...COMPOSE_FIELDS, "deploy"]),
			replaces: changed(olds, news, ["environmentId", "appName"])
				? ["environmentId", "appName"]
				: [],
			deleteBeforeReplace: true,
		};
	},
	async update(id, olds, news) {
		const conn = connOf(news);
		await call(
			conn,
			"compose.update",
			{ composeId: id, ...composeBody(news) },
			"POST",
		);
		if (news.deploy && changed(olds, news, COMPOSE_FIELDS)) {
			await call(
				conn,
				"compose.deploy",
				{ composeId: id, title: "Pulumi redeploy" },
				"POST",
			);
		}
		return { outs: { ...news, composeId: id } };
	},
	async delete(id, props) {
		await call(
			connOf(props),
			"compose.delete",
			{ composeId: id, deleteVolumes: props.deleteVolumesOnDestroy ?? false },
			"POST",
		);
	},
};

export class Compose extends pulumi.dynamic.Resource {
	public readonly composeId!: pulumi.Output<string>;
	public readonly appName!: pulumi.Output<string>;
	constructor(
		name: string,
		args: ComposeArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			composeProvider,
			name,
			{ composeId: undefined, appName: undefined, ...args },
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
	}
}
