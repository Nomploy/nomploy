CREATE TABLE "lb_metric_sample" (
	"lbMetricSampleId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"node" text NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"reqTotal" double precision DEFAULT 0 NOT NULL,
	"req2xx" double precision DEFAULT 0 NOT NULL,
	"req4xx" double precision DEFAULT 0 NOT NULL,
	"req5xx" double precision DEFAULT 0 NOT NULL,
	"durSum" double precision DEFAULT 0 NOT NULL,
	"durCount" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lb_metric_sample" ADD CONSTRAINT "lb_metric_sample_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lb_metric_sample_org_ts_idx" ON "lb_metric_sample" USING btree ("organizationId","ts");