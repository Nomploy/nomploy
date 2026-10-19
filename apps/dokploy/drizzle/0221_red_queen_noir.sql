CREATE TABLE "cost_sample" (
	"sampleId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"createdAt" text NOT NULL,
	"projectId" text,
	"projectName" text,
	"monthly" double precision DEFAULT 0 NOT NULL,
	"total" double precision,
	"allocated" double precision,
	"platform" double precision,
	"idle" double precision
);
--> statement-breakpoint
CREATE INDEX "cost_sample_org_idx" ON "cost_sample" USING btree ("organizationId","projectId","createdAt");