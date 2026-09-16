ALTER TABLE "compose" ADD COLUMN "autoscalingEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "minReplicas" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "maxReplicas" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "autoscaleCpuTarget" integer;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "autoscaleMemoryTarget" integer;