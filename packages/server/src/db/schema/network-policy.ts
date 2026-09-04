import { relations } from "drizzle-orm";
import { pgTable, text, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { projects } from "./project";

/**
 * Phase B network segmentation: an allow-rule letting one project's nodes reach
 * another isolated project's nodes over the WireGuard overlay. Absence of a rule
 * means default-deny (an isolated project only accepts overlay traffic from its
 * own nodes + the control-plane hub). Rules are directional: source → target.
 */
export const networkPolicies = pgTable(
	"network_policy",
	{
		networkPolicyId: text("networkPolicyId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		// The project allowed to initiate traffic.
		sourceProjectId: text("sourceProjectId")
			.notNull()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		// The (isolated) project that will accept traffic from the source.
		targetProjectId: text("targetProjectId")
			.notNull()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		uniquePair: unique("unique_network_policy_pair").on(
			table.sourceProjectId,
			table.targetProjectId,
		),
	}),
);

export const networkPolicyRelations = relations(networkPolicies, ({ one }) => ({
	organization: one(organization, {
		fields: [networkPolicies.organizationId],
		references: [organization.id],
	}),
	sourceProject: one(projects, {
		fields: [networkPolicies.sourceProjectId],
		references: [projects.projectId],
		relationName: "networkPolicySource",
	}),
	targetProject: one(projects, {
		fields: [networkPolicies.targetProjectId],
		references: [projects.projectId],
		relationName: "networkPolicyTarget",
	}),
}));

const createSchema = createInsertSchema(networkPolicies, {
	sourceProjectId: z.string().min(1),
	targetProjectId: z.string().min(1),
});

export const apiCreateNetworkPolicy = createSchema
	.pick({
		sourceProjectId: true,
		targetProjectId: true,
	})
	.required();

export const apiRemoveNetworkPolicy = z.object({
	networkPolicyId: z.string().min(1),
});
