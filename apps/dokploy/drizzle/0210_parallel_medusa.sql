CREATE TABLE "alert_silence" (
	"silenceId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"startsAt" timestamp DEFAULT now() NOT NULL,
	"endsAt" timestamp NOT NULL,
	"alertRuleId" text,
	"target" text,
	"severity" text,
	"createdBy" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_event" ADD COLUMN "silenced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_silence" ADD CONSTRAINT "alert_silence_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_silence" ADD CONSTRAINT "alert_silence_alertRuleId_alert_rule_alertRuleId_fk" FOREIGN KEY ("alertRuleId") REFERENCES "public"."alert_rule"("alertRuleId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_silence_org_ends_idx" ON "alert_silence" USING btree ("organizationId","endsAt");