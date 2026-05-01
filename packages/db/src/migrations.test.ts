import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertMigrationsAppliedForClient } from "./migrations";

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationsDir = fileURLToPath(migrationsUrl);

// drizzle-kit 1.0 layout: each migration is a `<timestamp>_<name>/` folder
// containing `migration.sql` + `snapshot.json`. The pre-1.0 layout had
// `<idx>_<name>.sql` flat plus a shared `meta/_journal.json`. The migration
// folder was upgraded to the 1.0 format via `drizzle-kit up`.
const migrationFolderPattern = /^\d{14}_/;

const expectedTables = [
  "organizations",
  "users",
  "org_members",
  "workflows",
  "workflow_versions",
  "runs",
  "run_nodes",
  "run_events",
  "dead_letters",
  "routing_stats",
  "workflow_improvements",
  "usage_events",
  "credentials",
  "installed_plugins",
  "audit_logs",
];

const expectedIndexes = [
  "org_members_org_user_idx",
  "workflows_org_created_idx",
  "workflow_versions_org_workflow_version_idx",
  "workflow_versions_org_workflow_created_idx",
  "runs_org_created_idx",
  "run_nodes_run_node_idx",
  "run_events_run_created_idx",
  "dead_letters_org_status_idx",
  "routing_stats_org_node_idx",
  "workflow_improvements_org_workflow_idx",
  "usage_events_org_metric_idx",
  "credentials_org_idx",
  "installed_plugins_org_plugin_idx",
  "audit_logs_org_created_idx",
];

describe("drizzle migrations", () => {
  it("accepts a database with the Drizzle migrations table", async () => {
    let inspectedQuery = "";
    const migrationClient = {
      unsafe: async (query: string) => {
        inspectedQuery = query;
        return [{ exists: true }];
      },
    };

    await expect(assertMigrationsAppliedForClient(migrationClient)).resolves.toBeUndefined();
    expect(inspectedQuery).toContain("information_schema.tables");
    expect(inspectedQuery).toContain("__drizzle_migrations");
  });

  it("fails fast when the Drizzle migrations table is missing", async () => {
    const migrationClient = {
      unsafe: async () => [{ exists: false }],
    };

    await expect(assertMigrationsAppliedForClient(migrationClient)).rejects.toThrow(
      "Database is not migrated. Run `pnpm migrate` against DATABASE_URL before starting the API/worker.",
    );
  });

  it("migrations folder contains at least one timestamped migration", () => {
    const folders = readdirSync(migrationsDir).filter((name) => {
      if (!migrationFolderPattern.test(name)) return false;
      return statSync(new URL(`${name}/`, migrationsUrl)).isDirectory();
    });
    expect(folders.length, "expected at least one <timestamp>_<name>/ migration folder").toBeGreaterThan(0);
  });

  it("the initial migration creates every table and index in schema.ts", () => {
    const folders = readdirSync(migrationsDir)
      .filter((name) => migrationFolderPattern.test(name))
      .filter((name) => statSync(new URL(`${name}/`, migrationsUrl)).isDirectory())
      .sort();
    expect(folders[0], "expected at least one timestamped migration folder").toBeDefined();

    const sql = readFileSync(new URL(`${folders[0]}/migration.sql`, migrationsUrl), "utf8");

    for (const table of expectedTables) {
      expect(sql, `migration must create table ${table}`).toMatch(new RegExp(`CREATE TABLE\\s+"${table}"`));
    }

    for (const idx of expectedIndexes) {
      expect(sql, `migration must create index ${idx}`).toContain(`"${idx}"`);
    }
  });
});
