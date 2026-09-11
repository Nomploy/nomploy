ALTER TABLE "application" ADD COLUMN "updateMaxParallel" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "canaryCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "autoPromote" boolean DEFAULT false NOT NULL;