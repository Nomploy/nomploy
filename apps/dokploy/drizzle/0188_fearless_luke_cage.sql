CREATE TABLE "autoscaling_schedule" (
	"scheduleId" text PRIMARY KEY NOT NULL,
	"autoscalerId" text NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"cronExpression" text NOT NULL,
	"desiredNodes" integer NOT NULL,
	"minNodes" integer,
	"maxNodes" integer,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autoscaling_schedule" ADD CONSTRAINT "autoscaling_schedule_autoscalerId_cluster_autoscaler_autoscalerId_fk" FOREIGN KEY ("autoscalerId") REFERENCES "public"."cluster_autoscaler"("autoscalerId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autoscaling_schedule" ADD CONSTRAINT "autoscaling_schedule_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;