ALTER TYPE "composeType" ADD VALUE 'nomad';--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "nomadAddress" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "nomadToken" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "nomadNamespace" text DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "registryUrl" text;
