CREATE TABLE "org_configs" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"value_type" text NOT NULL,
	"source" text DEFAULT 'tenant' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "org_configs_org_key_idx" ON "org_configs" ("org_id","key");--> statement-breakpoint
CREATE INDEX "org_configs_org_category_idx" ON "org_configs" ("org_id","category");
