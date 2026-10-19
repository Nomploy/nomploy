CREATE TABLE "service_request_sample" (
	"sampleId" text PRIMARY KEY NOT NULL,
	"appName" text NOT NULL,
	"createdAt" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "service_request_sample_appName_idx" ON "service_request_sample" USING btree ("appName","createdAt");