CREATE TABLE "cloud_provider" (
	"cloudProviderId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'hetzner' NOT NULL,
	"token" text DEFAULT '' NOT NULL,
	"sshKeyId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_autoscaler" ADD COLUMN "cloudProviderId" text;--> statement-breakpoint
ALTER TABLE "cloud_provider" ADD CONSTRAINT "cloud_provider_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_provider" ADD CONSTRAINT "cloud_provider_sshKeyId_ssh-key_sshKeyId_fk" FOREIGN KEY ("sshKeyId") REFERENCES "public"."ssh-key"("sshKeyId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_autoscaler" ADD CONSTRAINT "cluster_autoscaler_cloudProviderId_cloud_provider_cloudProviderId_fk" FOREIGN KEY ("cloudProviderId") REFERENCES "public"."cloud_provider"("cloudProviderId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Data migration: lift each existing per-group cloud credential into a shared
-- cloud_provider (deduped by org+provider+token via a deterministic md5 id), then
-- point its groups at it. Groups keep their legacy token column as a dormant
-- fallback. Idempotent: the id is derived, so re-running upserts the same rows.
INSERT INTO "cloud_provider" ("cloudProviderId","organizationId","name","provider","token","sshKeyId","createdAt")
SELECT md5("organizationId" || ':' || "provider" || ':' || "token"),
       "organizationId",
       initcap("provider"),
       "provider",
       "token",
       max("sshKeyId"),
       now()
FROM "cluster_autoscaler"
WHERE "token" <> ''
GROUP BY "organizationId","provider","token"
ON CONFLICT ("cloudProviderId") DO NOTHING;--> statement-breakpoint
UPDATE "cluster_autoscaler" ca
SET "cloudProviderId" = md5(ca."organizationId" || ':' || ca."provider" || ':' || ca."token")
WHERE ca."token" <> '' AND ca."cloudProviderId" IS NULL;