CREATE INDEX IF NOT EXISTS "audit_logs_org_created_id_idx" ON "audit_logs" ("org_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_org_action_created_id_idx" ON "audit_logs" ("org_id","action" text_pattern_ops,"created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dead_letters_org_status_created_idx" ON "dead_letters" ("org_id","status","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dead_letters_org_created_id_idx" ON "dead_letters" ("org_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_run_steps_org_observed_created_idx" ON "external_run_steps" ("org_id","last_observed_at" DESC,"created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_runs_org_observed_created_idx" ON "external_runs" ("org_id","last_observed_at" DESC,"created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_workflows_org_observed_workflow_idx" ON "external_workflows" ("org_id","last_observed_at" DESC,"external_workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prompts_org_created_id_idx" ON "prompts" ("org_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_feedback_org_workflow_created_idx" ON "recovery_feedback" ("org_id","workflow_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "replay_campaigns_org_created_id_idx" ON "replay_campaigns" ("org_id","created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trigger_events_org_created_id_idx" ON "trigger_events" ("org_id","created_at" DESC,"id" DESC);--> statement-breakpoint
DROP INDEX IF EXISTS "audit_logs_org_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "audit_logs_org_action_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "dead_letters_org_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "dead_letters_org_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "external_run_steps_org_observed_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "external_runs_org_observed_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "external_workflows_org_observed_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "prompts_org_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "recovery_feedback_org_workflow_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "replay_campaigns_org_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "trigger_events_org_created_idx";
