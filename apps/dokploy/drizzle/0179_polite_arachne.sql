ALTER TABLE "application" ADD COLUMN "autoscalingEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "minReplicas" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "maxReplicas" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "autoscaleCpuTarget" integer;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "autoscaleMemoryTarget" integer;