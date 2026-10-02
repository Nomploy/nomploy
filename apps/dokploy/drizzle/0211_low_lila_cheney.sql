ALTER TABLE "alert_silence" ADD COLUMN "recurring" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_silence" ADD COLUMN "recurStartMinute" integer;--> statement-breakpoint
ALTER TABLE "alert_silence" ADD COLUMN "recurEndMinute" integer;--> statement-breakpoint
ALTER TABLE "alert_silence" ADD COLUMN "recurDays" integer[];