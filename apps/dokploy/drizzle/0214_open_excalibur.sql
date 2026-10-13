CREATE TABLE "crowdsec_ban_sample" (
	"crowdsecBanSampleId" text PRIMARY KEY NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"activeBans" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "crowdsec_ban_sample_ts_idx" ON "crowdsec_ban_sample" USING btree ("ts");