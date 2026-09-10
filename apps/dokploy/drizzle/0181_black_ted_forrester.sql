ALTER TABLE "cluster_autoscaler" DROP CONSTRAINT "cluster_autoscaler_organizationId_unique";--> statement-breakpoint
ALTER TABLE "cluster_autoscaler" ADD COLUMN "name" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster_autoscaler" ADD COLUMN "poolName" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster_autoscaler" ADD COLUMN "isDefault" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster_autoscaler_event" ADD COLUMN "groupId" text;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "nodePool" text;--> statement-breakpoint
-- Data migration: the pre-existing single config per org becomes that org's
-- "default" autoscaling group (name/poolName already default to 'default' via the
-- ADD COLUMN defaults above; mark it as the un-deletable default). All current
-- worker nodes live in the built-in `default` pool.
UPDATE "cluster_autoscaler" SET "isDefault" = true;--> statement-breakpoint
UPDATE "server" SET "nodePool" = 'default' WHERE "clusterRole" = 'worker';