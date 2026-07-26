CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"org_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "auth_sessions_user_expiry_idx" ON "auth_sessions" ("user_id","expires_at");