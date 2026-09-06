import { relations } from "drizzle-orm";
import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { sshKeys } from "./ssh-key";

/**
 * Phase C — cluster autoscaling config (one per organization). The reconcile
 * loop reads Nomad capacity + pending allocations and, within [minNodes,
 * maxNodes] and the cooldown, provisions worker VMs (cloud provider) + joins
 * them, or drains+removes+destroys idle ones. Only nodes it created (server rows
 * with autoscaled=true) are ever destroyed.
 */
export const clusterAutoscaler = pgTable("cluster_autoscaler", {
	autoscalerId: text("autoscalerId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.unique()
		.references(() => organization.id, { onDelete: "cascade" }),
	enabled: boolean("enabled").notNull().default(false),
	provider: text("provider").notNull().default("hetzner"),
	// Cloud API token. Stored like the other provider secrets in this schema
	// (plaintext at rest); never returned by read APIs (masked in the UI).
	token: text("token").notNull().default(""),
	serverType: text("serverType").notNull().default("cx22"),
	location: text("location").notNull().default("nbg1"),
	image: text("image").notNull().default("ubuntu-24.04"),
	// Cloud private-network id to attach new VMs to (so they get a private IP the
	// hub reaches, matching the Phase A join model). Empty = public IP only.
	networkId: text("networkId"),
	// Which stored SSH key to authorize on new VMs (the hub joins them with it).
	sshKeyId: text("sshKeyId").references(() => sshKeys.sshKeyId, {
		onDelete: "set null",
	}),
	minNodes: integer("minNodes").notNull().default(0),
	maxNodes: integer("maxNodes").notNull().default(3),
	// Cluster utilisation % that triggers scale up / scale down.
	scaleUpThreshold: integer("scaleUpThreshold").notNull().default(80),
	scaleDownThreshold: integer("scaleDownThreshold").notNull().default(25),
	// Minimum seconds between scaling actions (both directions).
	cooldownSeconds: integer("cooldownSeconds").notNull().default(300),
	// ISO timestamp of the last scaling action (for cooldown).
	lastScaleAt: text("lastScaleAt"),
});

export const clusterAutoscalerRelations = relations(
	clusterAutoscaler,
	({ one }) => ({
		organization: one(organization, {
			fields: [clusterAutoscaler.organizationId],
			references: [organization.id],
		}),
		sshKey: one(sshKeys, {
			fields: [clusterAutoscaler.sshKeyId],
			references: [sshKeys.sshKeyId],
		}),
	}),
);

const createSchema = createInsertSchema(clusterAutoscaler);

// Update input: token optional (only overwrite when provided) + never required.
export const apiUpdateClusterAutoscaler = createSchema
	.pick({
		enabled: true,
		provider: true,
		serverType: true,
		location: true,
		image: true,
		networkId: true,
		sshKeyId: true,
		minNodes: true,
		maxNodes: true,
		scaleUpThreshold: true,
		scaleDownThreshold: true,
		cooldownSeconds: true,
	})
	.partial()
	.extend({
		// Provided only when (re)setting the token; blank/undefined keeps existing.
		token: z.string().optional(),
	});
