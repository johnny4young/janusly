ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "org_id";