import { relations } from "drizzle-orm";
import {
	boolean,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { applications } from "./application";
import { certificates } from "./certificate";
import { compose } from "./compose";
import { deployments } from "./deployment";
import { libsql } from "./libsql";
import { mariadb } from "./mariadb";
import { mongo } from "./mongo";
import { mysql } from "./mysql";
import { postgres } from "./postgres";
import { redis } from "./redis";
import { schedules } from "./schedule";
import { sshKeys } from "./ssh-key";
import { generateAppName } from "./utils";
export const serverStatus = pgEnum("serverStatus", ["active", "inactive"]);
export const serverType = pgEnum("serverType", ["deploy", "build"]);

export const server = pgTable("server", {
	serverId: text("serverId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	description: text("description"),
	ipAddress: text("ipAddress").notNull(),
	port: integer("port").notNull(),
	username: text("username").notNull().default("root"),
	appName: text("appName")
		.notNull()
		.$defaultFn(() => generateAppName("server")),
	enableDockerCleanup: boolean("enableDockerCleanup").notNull().default(false),
	createdAt: text("createdAt").notNull(),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	serverStatus: serverStatus("serverStatus").notNull().default("active"),
	serverType: serverType("serverType").notNull().default("deploy"),
	command: text("command").notNull().default(""),
	sshKeyId: text("sshKeyId").references(() => sshKeys.sshKeyId, {
		onDelete: "set null",
	}),
	metricsConfig: jsonb("metricsConfig")
		.$type<{
			server: {
				type: "Nomploy" | "Remote";
				refreshRate: number;
				port: number;
				token: string;
				urlCallback: string;
				retentionDays: number;
				cronJob: string;
				thresholds: {
					cpu: number;
					memory: number;
				};
			};
			containers: {
				refreshRate: number;
				services: {
					include: string[];
					exclude: string[];
				};
			};
		}>()
		.notNull()
		.default({
			server: {
				type: "Remote",
				refreshRate: 60,
				port: 4500,
				token: "",
				urlCallback: "",
				cronJob: "",
				retentionDays: 2,
				thresholds: {
					cpu: 0,
					memory: 0,
				},
			},
			containers: {
				refreshRate: 60,
				services: {
					include: [],
					exclude: [],
				},
			},
		}),
	nomadAddress: text("nomadAddress"),
	nomadToken: text("nomadToken"),
	nomadNamespace: text("nomadNamespace").default("default"),
	registryUrl: text("registryUrl"),
	// Cluster membership (set when the server joins the Nomad/WireGuard cluster).
	// cluster.json remains the source of truth for WireGuard; these mirror it for
	// convenient querying. "server" = Nomad/Consul server (raft), "worker" = client.
	clusterRole: text("clusterRole"),
	wgIp: text("wgIp"),
	wgPublicKey: text("wgPublicKey"),
});

export const serverRelations = relations(server, ({ one, many }) => ({
	deployments: many(deployments, {
		relationName: "deploymentServer",
	}),
	buildDeployments: many(deployments, {
		relationName: "deploymentBuildServer",
	}),
	sshKey: one(sshKeys, {
		fields: [server.sshKeyId],
		references: [sshKeys.sshKeyId],
	}),
	applications: many(applications, {
		relationName: "applicationServer",
	}),
	buildApplications: many(applications, {
		relationName: "applicationBuildServer",
	}),
	compose: many(compose),
	libsql: many(libsql),
	redis: many(redis),
	mariadb: many(mariadb),
	mongo: many(mongo),
	mysql: many(mysql),
	postgres: many(postgres),
	certificates: many(certificates),
	organization: one(organization, {
		fields: [server.organizationId],
		references: [organization.id],
	}),
	schedules: many(schedules),
}));

const createSchema = createInsertSchema(server, {
	serverId: z.string().min(1),
	name: z.string().min(1),
	description: z.string().optional(),
	serverType: z.enum(["deploy", "build"]).optional(),
});

export const apiCreateServer = createSchema
	.pick({
		name: true,
		description: true,
		ipAddress: true,
		port: true,
		username: true,
		sshKeyId: true,
		serverType: true,
	})
	.required();

export const apiFindOneServer = z.object({
	serverId: z.string().min(1),
});

export const apiRemoveServer = createSchema
	.pick({
		serverId: true,
	})
	.required();

export const apiUpdateServer = createSchema
	.pick({
		name: true,
		description: true,
		serverId: true,
		ipAddress: true,
		port: true,
		username: true,
		sshKeyId: true,
		serverType: true,
	})
	.required()
	.extend({
		command: z.string().optional(),
		nomadAddress: z.string().nullish(),
		nomadToken: z.string().nullish(),
		nomadNamespace: z.string().nullish(),
		registryUrl: z.string().nullish(),
		clusterRole: z.string().nullish(),
		wgIp: z.string().nullish(),
		wgPublicKey: z.string().nullish(),
	});

export const apiUpdateServerMonitoring = createSchema
	.pick({
		serverId: true,
	})
	.required()
	.extend({
		metricsConfig: z
			.object({
				server: z.object({
					refreshRate: z.number().min(2),
					port: z.number().min(1),
					token: z.string(),
					urlCallback: z.string().url(),
					retentionDays: z.number().min(1),
					cronJob: z.string().min(1),
					thresholds: z.object({
						cpu: z.number().min(0),
						memory: z.number().min(0),
					}),
				}),
				containers: z.object({
					refreshRate: z.number().min(2),
					services: z.object({
						include: z.array(z.string()).optional(),
						exclude: z.array(z.string()).optional(),
					}),
				}),
			})
			.required(),
	});
