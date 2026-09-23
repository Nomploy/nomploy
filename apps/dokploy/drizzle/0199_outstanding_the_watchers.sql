ALTER TABLE "compose" ADD COLUMN "nomadSecretsEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "compose" ADD COLUMN "configFiles" jsonb DEFAULT '[]'::jsonb NOT NULL;