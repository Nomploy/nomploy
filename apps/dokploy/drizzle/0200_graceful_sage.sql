CREATE TABLE "service_metric_sample" (
	"sampleId" text PRIMARY KEY NOT NULL,
	"appName" text NOT NULL,
	"createdAt" text NOT NULL,
	"cpuUsedMhz" integer DEFAULT 0 NOT NULL,
	"cpuAllocMhz" integer DEFAULT 0 NOT NULL,
	"memUsedMb" integer DEFAULT 0 NOT NULL,
	"memAllocMb" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "service_metric_sample_appName_idx" ON "service_metric_sample" USING btree ("appName","createdAt");