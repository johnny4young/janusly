import { pgTable, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  email: text("email"),
  name: text("name"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const workflows = pgTable("workflows", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().default("default"),
  name: text("name").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const workflowVersions = pgTable("workflow_versions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().default("default"),
  workflowId: text("workflow_id").notNull(),
  version: integer("version").notNull(),
  dagJson: jsonb("dag_json").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().default("default"),
  workflowVersionId: text("workflow_version_id").notNull(),
  status: text("status").notNull(),
  inputJson: jsonb("input_json"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const runNodes = pgTable("run_nodes", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  status: text("status").notNull(),
  stateJson: jsonb("state_json"),
  attempts: integer("attempts").default(0),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  errorJson: jsonb("error_json"),
});

export const runEvents = pgTable("run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  nodeId: text("node_id"),
  type: text("type").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const usageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id"),
  runId: text("run_id"),
  metric: text("metric").notNull(),
  quantity: integer("quantity").notNull().default(1),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  secretRef: text("secret_ref").notNull(),
  metadata: jsonb("metadata"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const installedPlugins = pgTable("installed_plugins", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  pluginId: text("plugin_id").notNull(),
  configJson: jsonb("config_json"),
  installedBy: text("installed_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});
