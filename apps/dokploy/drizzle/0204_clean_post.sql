CREATE TABLE "alert_event" (
	"alertEventId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"alertRuleId" text NOT NULL,
	"type" text NOT NULL,
	"value" double precision DEFAULT 0 NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rule" (
	"alertRuleId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"target" text,
	"comparator" text DEFAULT 'gt' NOT NULL,
	"threshold" double precision NOT NULL,
	"forMinutes" integer DEFAULT 5 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"lastValue" double precision,
	"lastStateChangeAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_alertRuleId_alert_rule_alertRuleId_fk" FOREIGN KEY ("alertRuleId") REFERENCES "public"."alert_rule"("alertRuleId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_event_org_created_idx" ON "alert_event" USING btree ("organizationId","createdAt");