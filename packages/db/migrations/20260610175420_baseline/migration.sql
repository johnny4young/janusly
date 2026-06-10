-- Development baseline: condenses the 31 pre-production migrations
-- (20260429022417_tranquil_gravity .. 20260604161653_parallel_mystique)
-- into a single snapshot of `src/schema.ts`. Squashed 2026-06-10 while
-- no production database existed; an existing dev database must be
-- recreated (`docker compose down -v`) before `pnpm migrate`.
--
-- Three hand-additions survive the squash (drizzle-kit cannot emit
-- them; everything else is its pure output — same documented exception
-- the original migrations carried):
--   1. `CREATE EXTENSION vector` (pgvector, required by memory_entries)
--   2. the `jsonb_path_ops` opclass on audit_logs_metadata_gin_idx
--   3. the `USING hnsw` cosine index on memory_entries.embedding
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "alert_dispatches" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"channel_results" jsonb NOT NULL,
	"trigger_payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_policies" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"parameters" jsonb DEFAULT '{}' NOT NULL,
	"channels" jsonb NOT NULL,
	"cooldown_seconds" integer DEFAULT 900 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"hold_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auto_healing_runs" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"dead_letter_id" text NOT NULL,
	"signature" text NOT NULL,
	"status" text NOT NULL,
	"proposed_patch_json" jsonb,
	"approach_label" text,
	"confidence" integer,
	"validation_run_id" text,
	"validation_signature" text,
	"decision_actor" text,
	"decline_reason" text,
	"loop_attempt_count" integer NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "confidence_calibrations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"approach_label" text NOT NULL,
	"accept_rate" real NOT NULL,
	"sample_size" integer NOT NULL,
	"curve_slope" real NOT NULL,
	"curve_intercept" real NOT NULL,
	"last_computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"secret_ref" text NOT NULL,
	"metadata" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp(3) with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "dead_letters" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"workflow_json" jsonb NOT NULL,
	"node_json" jsonb NOT NULL,
	"error_json" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"replayed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "eval_datasets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"workflow_id" text,
	"example_count" integer DEFAULT 0 NOT NULL,
	"retention_days" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_examples" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"dataset_id" text NOT NULL,
	"source_feedback_id" text NOT NULL,
	"workflow_id" text,
	"dead_letter_id" text,
	"failure_signature" text DEFAULT '' NOT NULL,
	"input_context" text DEFAULT '' NOT NULL,
	"expected_approach_label" text NOT NULL,
	"accepted" boolean DEFAULT true NOT NULL,
	"suggestion_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"control_ref" text NOT NULL,
	"candidate_ref" text NOT NULL,
	"eval_dataset_id" text NOT NULL,
	"scorer_kind" text DEFAULT 'string_equality' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary_json" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "installed_plugins" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"config_json" jsonb,
	"installed_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"invited_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
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
	"expose_to_ai" boolean DEFAULT false NOT NULL,
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
	"rate_limit_per_min" integer,
	"expose_to_ai" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
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
	"retain_until" timestamp with time zone NOT NULL,
	"hold_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "onboarding_progress" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"step" text DEFAULT 'org_created' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"skipped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"restarted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "org_members" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'viewer' NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "org_roles" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"inherits_from" text NOT NULL,
	"description" text,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"granted_permissions" jsonb,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"prompt_id" text NOT NULL,
	"version" integer NOT NULL,
	"template_text" text NOT NULL,
	"variables" jsonb DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"pinned_version_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "recovery_feedback" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"user_id" text,
	"dead_letter_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"suggestion_mode" text NOT NULL,
	"approach_label" text NOT NULL,
	"accepted" boolean NOT NULL,
	"raw_confidence" integer,
	"comment" text,
	"eval_consent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"hold_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recovery_item_children" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"recovery_item_id" text NOT NULL,
	"dead_letter_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "recovery_items" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"dead_letter_id" text NOT NULL,
	"workflow_id" text,
	"owner" text,
	"severity" text DEFAULT 'p3' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"sla_target_at" timestamp with time zone NOT NULL,
	"resolution_reason" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"comments" jsonb DEFAULT '[]' NOT NULL,
	"error_signature" text,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_stats" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"pulls" integer DEFAULT 0 NOT NULL,
	"value" real DEFAULT 0 NOT NULL,
	"mean_reward" real DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"node_id" text,
	"type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"hold_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_nodes" (
	"id" text PRIMARY KEY,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" text NOT NULL,
	"state_json" jsonb,
	"attempts" integer DEFAULT 0,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"workflow_version_id" text NOT NULL,
	"status" text NOT NULL,
	"input_json" jsonb,
	"output_json" jsonb,
	"parent_run_id" text,
	"parent_node_id" text,
	"trace_id" text,
	"replay_mode" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "schedule_entries" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_version_id" text NOT NULL,
	"node_id" text NOT NULL,
	"cron_expression" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_directories" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"provider_directory_id" text NOT NULL,
	"directory_type" text,
	"default_role" text DEFAULT 'viewer' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_group_role_mappings" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"provider_group_id" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_group_state" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"provider_group_id" text NOT NULL,
	"name" text NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_processed_events" (
	"event_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_user_groups" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"provider_group_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scim_user_state" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"scim_directory_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_event_id" text,
	"last_event_timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "snippets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"nodes_json" jsonb DEFAULT '[]' NOT NULL,
	"edges_json" jsonb DEFAULT '[]' NOT NULL,
	"entry_node_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_connection_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"enforced_sso" boolean DEFAULT false NOT NULL,
	"config_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sso_state_nonces" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "trigger_events" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"trigger_type" text NOT NULL,
	"workflow_id" text,
	"workflow_version_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"run_id" text,
	"dedupe_key" text,
	"payload_json" jsonb NOT NULL,
	"skipped_reason" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "upstream_health_sources" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"expected_components" jsonb DEFAULT '[]' NOT NULL,
	"check_interval_seconds" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_status" text,
	"last_degraded" boolean DEFAULT false NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"user_id" text,
	"run_id" text,
	"metric" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"hold_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"email" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "verified_domains" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"domain" text NOT NULL,
	"default_role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workflow_budgets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"monthly_usd" real NOT NULL,
	"warn_percent" integer DEFAULT 80 NOT NULL,
	"policy" text DEFAULT 'warn' NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workflow_improvements" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"base_version" integer,
	"new_version" integer,
	"action" jsonb,
	"reason" text,
	"before_metrics" jsonb,
	"after_metrics" jsonb,
	"confidence" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workflow_metadata" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"owners" jsonb DEFAULT '[]' NOT NULL,
	"runbook_markdown" text,
	"description" text,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"slack_channel" text,
	"linear_project" text,
	"severity_default" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"dag_json" jsonb NOT NULL,
	"slo_json" jsonb,
	"upstream_health_sources" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY,
	"org_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "alert_dispatches_org_policy_dedupe_idx" ON "alert_dispatches" ("org_id","policy_id","dedupe_key","dispatched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alert_dispatches_org_dispatched_idx" ON "alert_dispatches" ("org_id","dispatched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "alert_policies_org_name_idx" ON "alert_policies" ("org_id","name");--> statement-breakpoint
CREATE INDEX "alert_policies_org_trigger_enabled_idx" ON "alert_policies" ("org_id","trigger","enabled");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_metadata_gin_idx" ON "audit_logs" USING gin ("metadata" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "auto_healing_runs_org_status_created_idx" ON "auto_healing_runs" ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auto_healing_runs_org_signature_created_idx" ON "auto_healing_runs" ("org_id","signature","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auto_healing_runs_org_dlq_idx" ON "auto_healing_runs" ("org_id","dead_letter_id");--> statement-breakpoint
CREATE INDEX "auto_healing_runs_org_validated_idx" ON "auto_healing_runs" ("org_id") WHERE "status" = 'validated';--> statement-breakpoint
CREATE UNIQUE INDEX "confidence_calibrations_org_approach_idx" ON "confidence_calibrations" ("org_id","approach_label");--> statement-breakpoint
CREATE INDEX "credentials_org_idx" ON "credentials" ("org_id");--> statement-breakpoint
CREATE INDEX "dead_letters_org_status_idx" ON "dead_letters" ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "eval_datasets_org_name_idx" ON "eval_datasets" ("org_id","name");--> statement-breakpoint
CREATE INDEX "eval_datasets_org_created_idx" ON "eval_datasets" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "eval_examples_org_dataset_idx" ON "eval_examples" ("org_id","dataset_id");--> statement-breakpoint
CREATE INDEX "experiments_org_created_idx" ON "experiments" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "experiments_org_dataset_idx" ON "experiments" ("org_id","eval_dataset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installed_plugins_org_plugin_idx" ON "installed_plugins" ("org_id","plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_org_email_idx" ON "invitations" ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_org_alias_idx" ON "mcp_connections" ("org_id","alias");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tool_descriptors_connection_name_idx" ON "mcp_tool_descriptors" ("connection_id","name");--> statement-breakpoint
CREATE INDEX "memory_entries_org_kind_created_idx" ON "memory_entries" ("org_id","kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memory_entries_org_retain_until_idx" ON "memory_entries" ("org_id","retain_until");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_progress_org_user_idx" ON "onboarding_progress" ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_configs_org_key_idx" ON "org_configs" ("org_id","key");--> statement-breakpoint
CREATE INDEX "org_configs_org_category_idx" ON "org_configs" ("org_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_org_user_idx" ON "org_members" ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_roles_org_name_idx" ON "org_roles" ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_org_prompt_version_idx" ON "prompt_versions" ("org_id","prompt_id","version");--> statement-breakpoint
CREATE INDEX "prompt_versions_org_prompt_created_idx" ON "prompt_versions" ("org_id","prompt_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_org_name_idx" ON "prompts" ("org_id","name");--> statement-breakpoint
CREATE INDEX "prompts_org_created_idx" ON "prompts" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_feedback_org_workflow_idx" ON "recovery_feedback" ("org_id","workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_feedback_org_dlq_idx" ON "recovery_feedback" ("org_id","dead_letter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_item_children_item_dlq_idx" ON "recovery_item_children" ("recovery_item_id","dead_letter_id");--> statement-breakpoint
CREATE INDEX "recovery_item_children_item_occurred_idx" ON "recovery_item_children" ("recovery_item_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_item_handoffs_org_item_dest_idx" ON "recovery_item_handoffs" ("org_id","recovery_item_id","destination");--> statement-breakpoint
CREATE INDEX "recovery_item_handoffs_org_lastdispatched_idx" ON "recovery_item_handoffs" ("org_id","last_dispatched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_items_org_dlq_idx" ON "recovery_items" ("org_id","dead_letter_id");--> statement-breakpoint
CREATE INDEX "recovery_items_org_status_sla_idx" ON "recovery_items" ("org_id","status","sla_target_at");--> statement-breakpoint
CREATE INDEX "recovery_items_org_owner_idx" ON "recovery_items" ("org_id","owner");--> statement-breakpoint
CREATE INDEX "recovery_items_org_wf_sig_idx" ON "recovery_items" ("org_id","workflow_id","error_signature");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_stats_org_node_idx" ON "routing_stats" ("org_id","node_id");--> statement-breakpoint
CREATE INDEX "run_events_run_created_idx" ON "run_events" ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_nodes_run_node_idx" ON "run_nodes" ("run_id","node_id");--> statement-breakpoint
CREATE INDEX "runs_org_created_idx" ON "runs" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_parent_idx" ON "runs" ("parent_run_id");--> statement-breakpoint
CREATE INDEX "runs_org_replay_mode_idx" ON "runs" ("org_id","replay_mode");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_entries_org_version_node_idx" ON "schedule_entries" ("org_id","workflow_version_id","node_id");--> statement-breakpoint
CREATE INDEX "schedule_entries_org_enabled_idx" ON "schedule_entries" ("org_id","enabled");--> statement-breakpoint
CREATE INDEX "schedule_entries_org_workflow_idx" ON "schedule_entries" ("org_id","workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_directories_org_idx" ON "scim_directories" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_directories_provider_directory_idx" ON "scim_directories" ("provider_directory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_group_role_mappings_directory_group_idx" ON "scim_group_role_mappings" ("scim_directory_id","provider_group_id");--> statement-breakpoint
CREATE INDEX "scim_group_role_mappings_org_idx" ON "scim_group_role_mappings" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_group_state_directory_group_idx" ON "scim_group_state" ("scim_directory_id","provider_group_id");--> statement-breakpoint
CREATE INDEX "scim_processed_events_processed_at_idx" ON "scim_processed_events" ("processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_groups_user_group_idx" ON "scim_user_groups" ("scim_directory_id","provider_user_id","provider_group_id");--> statement-breakpoint
CREATE INDEX "scim_user_groups_directory_user_idx" ON "scim_user_groups" ("scim_directory_id","provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_user_state_directory_user_idx" ON "scim_user_state" ("scim_directory_id","provider_user_id");--> statement-breakpoint
CREATE INDEX "scim_user_state_org_email_idx" ON "scim_user_state" ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_org_name_idx" ON "snippets" ("org_id","name");--> statement-breakpoint
CREATE INDEX "snippets_org_updated_idx" ON "snippets" ("org_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_org_provider_idx" ON "sso_connections" ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_state_nonces_org_nonce_idx" ON "sso_state_nonces" ("org_id","nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_events_org_dedupe_idx" ON "trigger_events" ("org_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "trigger_events_org_created_idx" ON "trigger_events" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_events_org_node_idx" ON "trigger_events" ("org_id","workflow_version_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upstream_health_sources_org_name_idx" ON "upstream_health_sources" ("org_id","name");--> statement-breakpoint
CREATE INDEX "upstream_health_sources_enabled_idx" ON "upstream_health_sources" ("enabled");--> statement-breakpoint
CREATE INDEX "usage_events_org_metric_idx" ON "usage_events" ("org_id","metric");--> statement-breakpoint
CREATE INDEX "usage_events_org_metric_created_idx" ON "usage_events" ("org_id","metric","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "verified_domains_org_domain_idx" ON "verified_domains" ("org_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_budgets_org_workflow_idx" ON "workflow_budgets" ("org_id","workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_improvements_org_workflow_idx" ON "workflow_improvements" ("org_id","workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_metadata_org_workflow_idx" ON "workflow_metadata" ("org_id","workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_metadata_org_updated_idx" ON "workflow_metadata" ("org_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_org_workflow_version_idx" ON "workflow_versions" ("org_id","workflow_id","version");--> statement-breakpoint
CREATE INDEX "workflow_versions_org_workflow_created_idx" ON "workflow_versions" ("org_id","workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflows_org_created_idx" ON "workflows" ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memory_entries_embedding_hnsw_idx" ON "memory_entries" USING hnsw ("embedding" vector_cosine_ops);