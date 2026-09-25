import { relations } from "drizzle-orm";
import {
	boolean,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { dnsProvider } from "./dns-provider";

/**
 * The HA "LoadBalancer" DNS config (one per org). The Traefik ingress pool runs
 * active/active on every node tagged `nomploy_lb` (see setup/traefik-ha.ts); this
 * row owns the DNS side of Phase 2b — a generated hostname whose A records are
 * kept equal to the *healthy* pool nodes' public IPs (health-prune), AWS-ALB
 * style. Users CNAME their app domains to {@link hostname}. `enabled` gates the
 * reconcile loop so setting it up never touches live DNS until switched on.
 */
export const loadBalancer = pgTable("load_balancer", {
	loadBalancerId: text("loadBalancerId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	// One LB per org.
	organizationId: text("organizationId")
		.notNull()
		.unique()
		.references(() => organization.id, { onDelete: "cascade" }),
	// The generated LB DNS name, e.g. "lb-a1b2c3.spertulo.sk".
	hostname: text("hostname").notNull(),
	// The DNS zone the hostname lives in, e.g. "spertulo.sk".
	zoneName: text("zoneName").notNull(),
	// Which registered DNS provider (Cloudflare account) manages the records.
	dnsProviderId: text("dnsProviderId").references(
		() => dnsProvider.dnsProviderId,
		{ onDelete: "set null" },
	),
	// When true, the health-prune loop keeps the A records in sync with healthy nodes.
	enabled: boolean("enabled").notNull().default(false),
	// A-record TTL in seconds (low for fast DNS failover).
	ttl: integer("ttl").notNull().default(60),
	// Last reconcile bookkeeping (shown in the UI).
	lastReconcileAt: timestamp("lastReconcileAt"),
	lastReconcileStatus: text("lastReconcileStatus"),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const loadBalancerRelations = relations(loadBalancer, ({ one }) => ({
	organization: one(organization, {
		fields: [loadBalancer.organizationId],
		references: [organization.id],
	}),
	dnsProvider: one(dnsProvider, {
		fields: [loadBalancer.dnsProviderId],
		references: [dnsProvider.dnsProviderId],
	}),
}));

const createSchema = createInsertSchema(loadBalancer, {
	hostname: z.string().min(1),
	zoneName: z.string().min(1),
});

export const apiUpsertLoadBalancer = z.object({
	dnsProviderId: z.string().min(1),
	// Optional overrides — hostname/zone are auto-generated on first setup.
	zoneName: z.string().optional(),
	ttl: z.number().int().min(1).max(86400).optional(),
});

export type LoadBalancer = typeof loadBalancer.$inferSelect;
export { createSchema as loadBalancerInsertSchema };
