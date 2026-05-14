CREATE TABLE "mcp_connections" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"alias" text NOT NULL,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb,
	"url" text,
	"env_refs" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"last_discovery_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "mcp_tool_descriptors" (
	"id" text PRIMARY KEY,
	"connection_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"input_schema" jsonb,
	"write_side" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_org_alias_idx" ON "mcp_connections" ("org_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_descriptors_connection_name_idx" ON "mcp_tool_descriptors" ("connection_id","name");