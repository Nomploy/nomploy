CREATE TABLE "load_balancer" (
	"loadBalancerId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"hostname" text NOT NULL,
	"zoneName" text NOT NULL,
	"dnsProviderId" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"ttl" integer DEFAULT 60 NOT NULL,
	"lastReconcileAt" timestamp,
	"lastReconcileStatus" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "load_balancer_organizationId_unique" UNIQUE("organizationId")
);
--> statement-breakpoint
ALTER TABLE "load_balancer" ADD CONSTRAINT "load_balancer_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_balancer" ADD CONSTRAINT "load_balancer_dnsProviderId_dns_provider_dnsProviderId_fk" FOREIGN KEY ("dnsProviderId") REFERENCES "public"."dns_provider"("dnsProviderId") ON DELETE set null ON UPDATE no action;