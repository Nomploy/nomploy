ALTER TYPE "public"."composeType" ADD VALUE 'nomad-pack';--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "nomadPack" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "nomadPackRegistry" text;