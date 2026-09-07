ALTER TABLE "cluster_autoscaler" ALTER COLUMN "serverType" SET DEFAULT 'cpx22';--> statement-breakpoint
ALTER TABLE "cluster_autoscaler" ADD COLUMN "memScaleUpThreshold" integer DEFAULT 75 NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster_autoscaler" ADD COLUMN "memScaleDownThreshold" integer DEFAULT 25 NOT NULL;