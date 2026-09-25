import { relations } from "drizzle-orm";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";

/**
 * A DNS provider account (credential) — registered once in Settings → DNS
 * Providers and used for ACME DNS-01 certificate issuance (so any Traefik
 * instance can obtain/renew certs without the HTTP-01 challenge hitting that
 * specific instance — the prerequisite for active/active "LoadBalancer" ingress).
 * Token is plaintext at rest like the other provider secrets in this DB, never
 * returned by read APIs (masked as `hasToken`). Cloudflare first; the `provider`
 * column keeps it open for more (route53, digitalocean, …). `enabled` gates
 * whether Traefik actually switches its cert resolver to DNS-01 — off by default
 * so creating a provider never silently changes live TLS.
 */
export const dnsProvider = pgTable("dns_provider", {
	dnsProviderId: text("dnsProviderId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	// Human label, e.g. "Cloudflare (spertulo.sk)".
	name: text("name").notNull(),
	// DNS vendor, e.g. "cloudflare".
	provider: text("provider").notNull().default("cloudflare"),
	// Provider API token (plaintext at rest; never returned by read APIs).
	token: text("token").notNull().default(""),
	// When true, Traefik's cert resolver uses ACME DNS-01 via this provider.
	enabled: boolean("enabled").notNull().default(false),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const dnsProviderRelations = relations(dnsProvider, ({ one }) => ({
	organization: one(organization, {
		fields: [dnsProvider.organizationId],
		references: [organization.id],
	}),
}));

const createSchema = createInsertSchema(dnsProvider, {
	name: z.string().min(1),
	provider: z.string().min(1),
	token: z.string(),
});

export const apiCreateDnsProvider = createSchema
	.pick({
		name: true,
		provider: true,
		token: true,
		enabled: true,
	})
	.extend({
		token: z.string().min(1),
	});

export const apiFindOneDnsProvider = z.object({
	dnsProviderId: z.string().min(1),
});

export const apiRemoveDnsProvider = z.object({
	dnsProviderId: z.string().min(1),
});

// Update: token optional (blank/undefined keeps the existing one).
export const apiUpdateDnsProvider = createSchema
	.pick({
		name: true,
		provider: true,
		enabled: true,
	})
	.partial()
	.extend({
		dnsProviderId: z.string().min(1),
		token: z.string().optional(),
	});
