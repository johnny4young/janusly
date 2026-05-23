CREATE TABLE "recovery_item_handoffs" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"recovery_item_id" text NOT NULL,
	"destination" text NOT NULL,
	"credential_name" text NOT NULL,
	"external_id" text,
	"external_url" text,
	"idempotency_key" text NOT NULL,
	"last_outcome" text NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"last_latency_ms" integer,
	"dispatch_count" integer DEFAULT 1 NOT NULL,
	"first_dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_item_handoffs_org_item_dest_idx" ON "recovery_item_handoffs" ("org_id","recovery_item_id","destination");--> statement-breakpoint
CREATE INDEX "recovery_item_handoffs_org_lastdispatched_idx" ON "recovery_item_handoffs" ("org_id","last_dispatched_at" DESC NULLS LAST);
