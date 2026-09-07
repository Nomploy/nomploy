CREATE TABLE "cluster_autoscaler_event" (
	"eventId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "cluster_autoscaler_event" ADD CONSTRAINT "cluster_autoscaler_event_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;