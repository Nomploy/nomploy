// Demo Pulumi program: provision a project → application → domain on nomploy.
//
// Config (set with `pulumi config set …`):
//   nomploy-iac-demo:endpoint   https://your-nomploy-instance.com
//   nomploy-iac-demo:apiKey     <your x-api-key>   (use --secret)
//   nomploy-iac-demo:host       app.example.com    (the domain to route)

import * as pulumi from "@pulumi/pulumi";
import { Application, Domain, Project } from "./src/nomploy";

const config = new pulumi.Config();
const endpoint = config.require("endpoint");
const apiKey = config.requireSecret("apiKey");
const host = config.get("host"); // optional: skip the Domain if unset

const conn = { endpoint, apiKey };

// 1. Project — its create response hands back the auto-made production environment.
const project = new Project("demo", {
	...conn,
	name: "iac-demo",
	description: "Provisioned by Pulumi",
});

// 2. Application in that environment. (Source/build config + deploy are a later
//    increment — this creates the app record; configure the image in the panel or
//    extend the provider with application.saveDockerProvider + application.deploy.)
const app = new Application("demo-app", {
	...conn,
	name: "api",
	environmentId: project.environmentId,
});

// 3. Domain routed to the application (only when a host is configured).
export const domainId = host
	? new Domain("demo-domain", {
			...conn,
			host,
			applicationId: app.applicationId,
			port: 3000,
			https: true,
			certificateType: "letsencrypt",
		}).domainId
	: undefined;

export const projectId = project.projectId;
export const environmentId = project.environmentId;
export const applicationId = app.applicationId;
