ALTER TYPE "public"."scheduleType" ADD VALUE 'nomad-scale';--> statement-breakpoint
ALTER TABLE "schedule" ADD COLUMN "scaleCount" integer;