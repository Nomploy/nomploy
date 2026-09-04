CREATE TABLE "network_policy" (
	"networkPolicyId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"sourceProjectId" text NOT NULL,
	"targetProjectId" text NOT NULL,
	"createdAt" text NOT NULL,
	CONSTRAINT "unique_network_policy_pair" UNIQUE("sourceProjectId","targetProjectId")
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "isolated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "network_policy" ADD CONSTRAINT "network_policy_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_policy" ADD CONSTRAINT "network_policy_sourceProjectId_project_projectId_fk" FOREIGN KEY ("sourceProjectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_policy" ADD CONSTRAINT "network_policy_targetProjectId_project_projectId_fk" FOREIGN KEY ("targetProjectId") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;