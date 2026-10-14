ALTER TABLE "libsql" ADD COLUMN "internalPort" integer;--> statement-breakpoint
ALTER TABLE "mariadb" ADD COLUMN "internalPort" integer;--> statement-breakpoint
ALTER TABLE "mongo" ADD COLUMN "internalPort" integer;--> statement-breakpoint
ALTER TABLE "mysql" ADD COLUMN "internalPort" integer;--> statement-breakpoint
ALTER TABLE "postgres" ADD COLUMN "internalPort" integer;--> statement-breakpoint
ALTER TABLE "redis" ADD COLUMN "internalPort" integer;