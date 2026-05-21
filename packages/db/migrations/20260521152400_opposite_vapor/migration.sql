-- The two hand-additions in this file (`CREATE EXTENSION vector` and the
-- `USING hnsw` index) are the documented exceptions to AGENTS.md's
-- "no hand-edited migrations" rule. drizzle-kit cannot emit pgvector-
-- specific DDL today; everything else in this file is its pure output.

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text,
	"run_id" text,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedding_provider" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimension" integer NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retain_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "memory_entries_org_kind_created_idx" ON "memory_entries" ("org_id","kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memory_entries_org_retain_until_idx" ON "memory_entries" ("org_id","retain_until");--> statement-breakpoint
CREATE INDEX "memory_entries_embedding_hnsw_idx" ON "memory_entries" USING hnsw ("embedding" vector_cosine_ops);
