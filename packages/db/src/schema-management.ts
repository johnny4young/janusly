import { client } from "./index";

let schemaReady: Promise<void> | null = null;

export function ensureDatabaseSchema() {
  schemaReady ??= createSchema();
  return schemaReady;
}

async function createSchema() {
  await client.unsafe("SELECT pg_advisory_lock(483920177)");

  try {
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        email TEXT,
        name TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS org_members (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'viewer',
        invited_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS org_members_org_user_idx
        ON org_members (org_id, user_id);

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS workflow_versions (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default',
        workflow_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        dag_json JSONB NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS workflow_versions_org_workflow_version_idx
        ON workflow_versions (org_id, workflow_id, version);

      CREATE INDEX IF NOT EXISTS workflow_versions_org_workflow_created_idx
        ON workflow_versions (org_id, workflow_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS workflows_org_created_idx
        ON workflows (org_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default',
        workflow_version_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json JSONB,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS runs_org_created_idx
        ON runs (org_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS run_nodes (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        state_json JSONB,
        attempts INTEGER DEFAULT 0,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        error_json JSONB
      );

      CREATE UNIQUE INDEX IF NOT EXISTS run_nodes_run_node_idx
        ON run_nodes (run_id, node_id);

      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT,
        type TEXT NOT NULL,
        payload JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS run_events_run_created_idx
        ON run_events (run_id, created_at);

      CREATE TABLE IF NOT EXISTS dead_letters (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'default',
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        workflow_json JSONB NOT NULL,
        node_json JSONB NOT NULL,
        error_json JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        replayed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS dead_letters_org_status_idx
        ON dead_letters (org_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS routing_stats (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        pulls INTEGER NOT NULL DEFAULT 0,
        value REAL NOT NULL DEFAULT 0,
        mean_reward REAL NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS routing_stats_org_node_idx
        ON routing_stats (org_id, node_id);

      CREATE TABLE IF NOT EXISTS workflow_improvements (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        base_version INTEGER,
        new_version INTEGER,
        action JSONB,
        reason TEXT,
        before_metrics JSONB,
        after_metrics JSONB,
        confidence REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS workflow_improvements_org_workflow_idx
        ON workflow_improvements (org_id, workflow_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT,
        run_id TEXT,
        metric TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS usage_events_org_metric_idx
        ON usage_events (org_id, metric);

      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        metadata JSONB,
        created_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS credentials_org_idx
        ON credentials (org_id);

      CREATE TABLE IF NOT EXISTS installed_plugins (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        config_json JSONB,
        installed_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS installed_plugins_org_plugin_idx
        ON installed_plugins (org_id, plugin_id);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS audit_logs_org_created_idx
        ON audit_logs (org_id, created_at DESC);
    `);
  } finally {
    await client.unsafe("SELECT pg_advisory_unlock(483920177)");
  }
}
