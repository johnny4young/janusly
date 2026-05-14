CREATE TABLE "sso_state_nonces" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "sso_connections" ADD COLUMN "enforced_sso" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_state_nonces_org_nonce_idx" ON "sso_state_nonces" ("org_id","nonce");