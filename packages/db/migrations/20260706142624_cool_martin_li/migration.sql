CREATE INDEX IF NOT EXISTS "audit_logs_org_action_created_idx" ON "audit_logs" ("org_id","action" text_pattern_ops,"created_at" DESC NULLS LAST);
