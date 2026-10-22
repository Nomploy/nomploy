CREATE TABLE "uptime_kuma" (
	"uptimeKumaId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"baseUrl" text NOT NULL,
	"username" text NOT NULL,
	"password" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"autoMonitor" boolean DEFAULT true NOT NULL,
	"managedMonitors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lastSyncAt" timestamp,
	"lastSyncStatus" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uptime_kuma_organizationId_unique" UNIQUE("organizationId")
);
--> statement-breakpoint
ALTER TABLE "uptime_kuma" ADD CONSTRAINT "uptime_kuma_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;