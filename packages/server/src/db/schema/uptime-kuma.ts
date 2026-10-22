import { relations } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";

/**
 * Connection to an EXTERNAL Uptime Kuma instance (one per org). Nomploy keeps
 * Uptime Kuma HTTP monitors in sync with the domains that are actually pointed at
 * the LoadBalancer (see setup/loadbalancer-dns.ts): when a domain starts
 * resolving to the LB, a monitor for `https://<host>` is created; when it stops,
 * the monitor is removed.
 *
 * Uptime Kuma has no REST API for monitor CRUD — only its Socket.IO "internal
 * API" (login with username/password). So the admin `password` is stored here in
 * plaintext (masked on read, like {@link dnsProvider.token}) because the panel's
 * socket client — not a Nomad job — consumes it at sync time.
 *
 * {@link managedMonitors} maps each host we created a monitor for to that
 * monitor's Uptime Kuma id, so the reconcile only ever deletes monitors Nomploy
 * made — never a monitor the user added by hand.
 */
export const uptimeKuma = pgTable("uptime_kuma", {
	uptimeKumaId: text("uptimeKumaId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	// One connection per org.
	organizationId: text("organizationId")
		.notNull()
		.unique()
		.references(() => organization.id, { onDelete: "cascade" }),
	// Base URL of the Uptime Kuma instance, e.g. "https://uptime.spertulo.sk".
	baseUrl: text("baseUrl").notNull(),
	// Admin login for the Socket.IO internal API.
	username: text("username").notNull(),
	// Plaintext secret (masked as `hasPassword` on read) — the socket client needs it.
	password: text("password").notNull().default(""),
	// Gates the sync loop: nothing touches Uptime Kuma until switched on.
	enabled: boolean("enabled").notNull().default(false),
	// When true, monitors are auto-created/removed to match pointed LB domains.
	autoMonitor: boolean("autoMonitor").notNull().default(true),
	// host → Uptime Kuma monitor id, for every monitor Nomploy created. Used so the
	// reconcile prunes only our monitors and never clobbers user-made ones.
	managedMonitors: jsonb("managedMonitors")
		.$type<Record<string, number>>()
		.notNull()
		.default({}),
	// Last sync bookkeeping (shown in the UI).
	lastSyncAt: timestamp("lastSyncAt"),
	lastSyncStatus: text("lastSyncStatus"),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const uptimeKumaRelations = relations(uptimeKuma, ({ one }) => ({
	organization: one(organization, {
		fields: [uptimeKuma.organizationId],
		references: [organization.id],
	}),
}));

const createSchema = createInsertSchema(uptimeKuma, {
	baseUrl: z.string().url(),
	username: z.string().min(1),
});

export const apiConnectUptimeKuma = z.object({
	baseUrl: z.string().url(),
	username: z.string().min(1),
	// Optional on update: an empty value keeps the stored password.
	password: z.string().optional(),
	autoMonitor: z.boolean().optional(),
});

export const apiUpdateUptimeKuma = z.object({
	enabled: z.boolean().optional(),
	autoMonitor: z.boolean().optional(),
});

export type UptimeKuma = typeof uptimeKuma.$inferSelect;
export { createSchema as uptimeKumaInsertSchema };
