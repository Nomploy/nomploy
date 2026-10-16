ALTER TABLE "application" ADD COLUMN "crowdsecEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "crowdsecEnabled" boolean DEFAULT true NOT NULL;