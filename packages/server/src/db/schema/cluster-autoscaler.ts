import { relations } from "drizzle-orm";
import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { sshKeys } from "./ssh-key";

/**
 * An autoscaling group (Nomad node pool). Originally one config per org; now
 * MANY per org — each group is its own worker pool with its own launch template
 * (provider/serverType/location/…), min/max, thresholds, and cooldown, scaling
 * independently based on pressure within its node pool. The reconcile loop, for
 * each enabled group, reads that pool's Nomad capacity + pending allocations and,
 * within [minNodes, maxNodes] and the cooldown, provisions worker VMs into the
 * pool + joins them, or drains+removes+destroys idle ones. Only nodes it created
 * (server rows with autoscaled=true) are ever destroyed; manual nodes are pinned.
 *
 * The table keeps its original name (`cluster_autoscaler`) but is no longer
 * org-unique — `autoscalingGroup` is the meaningful alias. The built-in `default`
 * pool is the default group (isDefault=true), which existing installs migrate to.
 */
export const clusterAutoscaler = pgTable("cluster_autoscaler", {
	autoscalerId: text("autoscalerId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	// No longer unique per org — an org may have several groups.
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	// Human label for the group, e.g. "default", "memory", "gpu".
	name: text("name").notNull().default("default"),
	// Nomad node pool this group owns/scales (unique per org). Nodes join it and
	// jobs target it via `node_pool`. The built-in pool is "default".
	poolName: text("poolName").notNull().default("default"),
	// The default group can't be deleted; it backs the built-in `default` pool.
	isDefault: boolean("isDefault").notNull().default(false),
	enabled: boolean("enabled").notNull().default(false),
	provider: text("provider").notNull().default("hetzner"),
	// Cloud API token. Stored like the other provider secrets in this schema
	// (plaintext at rest); never returned by read APIs (masked in the UI).
	token: text("token").notNull().default(""),
	serverType: text("serverType").notNull().default("cpx22"),
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
	// Reservation-based scaling, evaluated per resource (two independent checks).
	// "Reservation" = sum of allocs' requested CPU/mem over cluster capacity (what
	// Nomad schedules on), NOT live usage. Scale UP if EITHER resource's reserved
	// % is at/above its up-threshold; scale DOWN only if BOTH are at/below their
	// down-thresholds. These two are the CPU-reservation policy:
	scaleUpThreshold: integer("scaleUpThreshold").notNull().default(80),
	scaleDownThreshold: integer("scaleDownThreshold").notNull().default(25),
	// …and these the memory-reservation policy (memory usually binds first):
	memScaleUpThreshold: integer("memScaleUpThreshold").notNull().default(75),
	memScaleDownThreshold: integer("memScaleDownThreshold").notNull().default(25),
	// Minimum seconds between scaling actions (both directions).
	cooldownSeconds: integer("cooldownSeconds").notNull().default(300),
	// ISO timestamp of the last scaling action (for cooldown).
	lastScaleAt: text("lastScaleAt"),
});

/**
 * Autoscaler activity log (like a cloud ASG's activity history). Every scaling
 * decision that acts, provision/join/remove/destroy step, and error is recorded
 * here and shown in the UI so operators can see what the autoscaler did and why.
 */
export const clusterAutoscalerEvents = pgTable("cluster_autoscaler_event", {
	eventId: text("eventId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	// Which autoscaling group this event belongs to (nullable for legacy rows).
	groupId: text("groupId"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	// scale_up | scale_down | error | info
	type: text("type").notNull(),
	message: text("message").notNull(),
	// Optional structured detail (node name, provider id, reason, …).
	detail: text("detail"),
});

export const clusterAutoscalerEventRelations = relations(
	clusterAutoscalerEvents,
	({ one }) => ({
		organization: one(organization, {
			fields: [clusterAutoscalerEvents.organizationId],
			references: [organization.id],
		}),
	}),
);

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

// `autoscalingGroup` is the meaningful name for the (now multi-row) table.
export const autoscalingGroup = clusterAutoscaler;

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
		memScaleUpThreshold: true,
		memScaleDownThreshold: true,
		cooldownSeconds: true,
	})
	.partial()
	.extend({
		// Provided only when (re)setting the token; blank/undefined keeps existing.
		token: z.string().optional(),
	});

// Upsert a group: groupId present = update that group, absent = create a new one.
// name/poolName identify the group + its Nomad node pool.
export const apiUpsertAutoscalingGroup = apiUpdateClusterAutoscaler.extend({
	groupId: z.string().optional(),
	name: z.string().min(1).optional(),
	// Node pool: lowercase letters, digits, hyphen, underscore (Nomad-safe).
	poolName: z
		.string()
		.regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, - or _")
		.optional(),
});
