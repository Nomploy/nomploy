import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { registry } from "./registry";

/**
 * Built-in OCI registry (zot) config — one per organization. When enabled, zot
 * runs as a Nomad job on the control plane (see utils/builders/nomad-zot.ts) and
 * a `registry` row is created pointing at it so builds push/pull there. Storage
 * is the local filesystem or an S3-compatible backend.
 */
export const zotRegistry = pgTable("zot_registry", {
	zotRegistryId: text("zotRegistryId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.unique()
		.references(() => organization.id, { onDelete: "cascade" }),
	enabled: boolean("enabled").notNull().default(false),
	port: integer("port").notNull().default(5000),
	// "local" (filesystem) or "s3" (S3-compatible backend).
	storageKind: text("storageKind").notNull().default("local"),
	s3Bucket: text("s3Bucket"),
	s3Region: text("s3Region"),
	// S3-compatible endpoint host (e.g. minio.example.com); empty for AWS.
	s3Endpoint: text("s3Endpoint"),
	// S3 credentials — plaintext at rest like the autoscaler token; masked in API.
	s3AccessKeyId: text("s3AccessKeyId"),
	s3SecretAccessKey: text("s3SecretAccessKey"),
	// Registry basic-auth. password is plaintext at rest (needed to re-hash the
	// htpasswd + docker login); masked in read APIs.
	username: text("username").notNull().default("nomploy"),
	password: text("password").notNull().default(""),
	// The `registry` row created for this built-in registry (so it shows in the
	// registry list + builds can target it).
	registryId: text("registryId").references(() => registry.registryId, {
		onDelete: "set null",
	}),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const apiUpsertZotRegistry = createInsertSchema(zotRegistry, {
	port: z.number().int().min(1).max(65535).optional(),
	storageKind: z.enum(["local", "s3"]).optional(),
	s3Bucket: z.string().optional(),
	s3Region: z.string().optional(),
	s3Endpoint: z.string().optional(),
	s3AccessKeyId: z.string().optional(),
	s3SecretAccessKey: z.string().optional(),
	username: z.string().min(1).optional(),
	password: z.string().optional(),
})
	.pick({
		enabled: true,
		port: true,
		storageKind: true,
		s3Bucket: true,
		s3Region: true,
		s3Endpoint: true,
		s3AccessKeyId: true,
		s3SecretAccessKey: true,
		username: true,
		password: true,
	})
	.partial();
