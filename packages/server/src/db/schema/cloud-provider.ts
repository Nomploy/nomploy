import { relations } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { sshKeys } from "./ssh-key";

/**
 * A cloud provider account (credential), registered once in Settings → Cloud and
 * referenced by autoscaling groups + one-click "Add node" — so the API token is
 * entered once, not pasted into every autoscaling group. Mirrors how S3
 * destinations / container registries are stored: the token is plaintext at rest
 * (like the other provider secrets in this DB), never returned by read APIs
 * (masked in the UI as `hasToken`). Only the credential lives here; the VM spec
 * (serverType/location/image/network) stays per autoscaling group.
 */
export const cloudProvider = pgTable("cloud_provider", {
	cloudProviderId: text("cloudProviderId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	// Human label, e.g. "Hetzner (prod)".
	name: text("name").notNull(),
	// Cloud vendor, e.g. "hetzner". Must be one of SUPPORTED_PROVIDERS.
	provider: text("provider").notNull().default("hetzner"),
	// Cloud API token (plaintext at rest; never returned by read APIs).
	token: text("token").notNull().default(""),
	// Default SSH key to authorize on new VMs (a group may still pick its own).
	sshKeyId: text("sshKeyId").references(() => sshKeys.sshKeyId, {
		onDelete: "set null",
	}),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const cloudProviderRelations = relations(cloudProvider, ({ one }) => ({
	organization: one(organization, {
		fields: [cloudProvider.organizationId],
		references: [organization.id],
	}),
	sshKey: one(sshKeys, {
		fields: [cloudProvider.sshKeyId],
		references: [sshKeys.sshKeyId],
	}),
}));

const createSchema = createInsertSchema(cloudProvider, {
	name: z.string().min(1),
	provider: z.string().min(1),
	token: z.string(),
});

export const apiCreateCloudProvider = createSchema
	.pick({
		name: true,
		provider: true,
		token: true,
		sshKeyId: true,
	})
	.extend({
		// Required on create (the whole point is to store a credential).
		token: z.string().min(1),
	});

export const apiFindOneCloudProvider = z.object({
	cloudProviderId: z.string().min(1),
});

export const apiRemoveCloudProvider = z.object({
	cloudProviderId: z.string().min(1),
});

// Update: token optional (blank/undefined keeps the existing one, like the
// autoscaler group's token-overwrite semantics).
export const apiUpdateCloudProvider = createSchema
	.pick({
		name: true,
		provider: true,
		sshKeyId: true,
	})
	.partial()
	.extend({
		cloudProviderId: z.string().min(1),
		token: z.string().optional(),
	});

// Validate a token against the provider API without saving (the "Test
// connection" button). Uses a saved provider's token when no token is given.
export const apiTestCloudProvider = z.object({
	provider: z.string().min(1),
	token: z.string().optional(),
	cloudProviderId: z.string().optional(),
});
