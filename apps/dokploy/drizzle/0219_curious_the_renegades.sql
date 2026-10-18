ALTER TABLE "application" ADD COLUMN "scaleToZeroEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "idleMinutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "isSleeping" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "sleepingSince" text;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "scaleToZeroEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "idleMinutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "isSleeping" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "sleepingSince" text;