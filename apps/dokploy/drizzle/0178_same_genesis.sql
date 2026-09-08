CREATE TABLE "zot_registry" (
	"zotRegistryId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"port" integer DEFAULT 5000 NOT NULL,
	"storageKind" text DEFAULT 'local' NOT NULL,
	"s3Bucket" text,
	"s3Region" text,
	"s3Endpoint" text,
	"s3AccessKeyId" text,
	"s3SecretAccessKey" text,
	"username" text DEFAULT 'nomploy' NOT NULL,
	"password" text DEFAULT '' NOT NULL,
	"registryId" text,
	"createdAt" text NOT NULL,
	CONSTRAINT "zot_registry_organizationId_unique" UNIQUE("organizationId")
);
--> statement-breakpoint
ALTER TABLE "zot_registry" ADD CONSTRAINT "zot_registry_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zot_registry" ADD CONSTRAINT "zot_registry_registryId_registry_registryId_fk" FOREIGN KEY ("registryId") REFERENCES "public"."registry"("registryId") ON DELETE set null ON UPDATE no action;