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
	/** Deploy on create, and redeploy whenever the image/source changes. */
	deploy?: pulumi.Input<boolean>;
}

/** Push the Docker source config when a dockerImage is set. */
async function applyDockerSource(conn: Conn, applicationId: string, p: any) {
	if (!p.dockerImage) return;
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
		await applyDockerSource(conn, applicationId, inputs);
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
		const sourceKeys = [
			"dockerImage",
			"registryUrl",
			"registryUsername",
			"registryPassword",
		];
		return {
			changes: changed(olds, news, ["name", "description", "deploy", ...sourceKeys]),
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
		const sourceChanged = changed(olds, news, [
			"dockerImage",
			"registryUrl",
			"registryUsername",
			"registryPassword",
		]);
		if (sourceChanged) await applyDockerSource(conn, id, news);
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
