CREATE TABLE "dns_provider" (
	"dnsProviderId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'cloudflare' NOT NULL,
	"token" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_provider" ADD CONSTRAINT "dns_provider_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;