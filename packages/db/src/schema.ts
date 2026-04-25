import { pgTable, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";

export const workflows = pgTable("workflows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const workflowVersions = pgTable("workflow_versions", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull(),
  version: integer("version").notNull(),
  dagJson: jsonb("dag_json").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  workflowVersionId: text("workflow_version_id").notNull(),
  status: text("status").notNull(),
  inputJson: jsonb("input_json"),
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
