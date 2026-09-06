CREATE TABLE "cluster_autoscaler" (
	"autoscalerId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" text DEFAULT 'hetzner' NOT NULL,
	"token" text DEFAULT '' NOT NULL,
	"serverType" text DEFAULT 'cx22' NOT NULL,
	"location" text DEFAULT 'nbg1' NOT NULL,
	"image" text DEFAULT 'ubuntu-24.04' NOT NULL,
	"networkId" text,
	"sshKeyId" text,
	"minNodes" integer DEFAULT 0 NOT NULL,
	"maxNodes" integer DEFAULT 3 NOT NULL,
	"scaleUpThreshold" integer DEFAULT 80 NOT NULL,
	"scaleDownThreshold" integer DEFAULT 25 NOT NULL,
	"cooldownSeconds" integer DEFAULT 300 NOT NULL,
	"lastScaleAt" text,
	CONSTRAINT "cluster_autoscaler_organizationId_unique" UNIQUE("organizationId")
);
--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "autoscaled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "providerNodeId" text;--> statement-breakpoint
ALTER TABLE "cluster_autoscaler" ADD CONSTRAINT "cluster_autoscaler_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_autoscaler" ADD CONSTRAINT "cluster_autoscaler_sshKeyId_ssh-key_sshKeyId_fk" FOREIGN KEY ("sshKeyId") REFERENCES "public"."ssh-key"("sshKeyId") ON DELETE set null ON UPDATE no action;