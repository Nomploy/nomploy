ALTER TABLE "registry" ADD COLUMN "destinationId" text;--> statement-breakpoint
ALTER TABLE "registry" ADD COLUMN "retention" jsonb;--> statement-breakpoint
ALTER TABLE "registry" ADD COLUMN "configOverride" jsonb;