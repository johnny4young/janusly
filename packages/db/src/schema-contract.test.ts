/**
 * Static database contract checks for Drizzle declarations and migrations.
 *
 * These tests intentionally avoid a database connection. Real-Postgres
 * integration tests remain the behavioral authority; this suite catches
 * definition drift before a migration reaches that lane.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable, type AnyPgColumn } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema";

type SnapshotTable = {
  entityType: "tables";
  name: string;
};

type SnapshotColumn = {
  entityType: "columns";
  table: string;
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
};

type SnapshotIndex = {
  entityType: "indexes";
  table: string;
  name: string;
  columns: Array<{ value: string }>;
  isUnique: boolean;
  where: string | null;
};

type SnapshotPrimaryKey = {
  entityType: "pks";
  table: string;
  columns: string[];
};

type SnapshotEntity = SnapshotTable | SnapshotColumn | SnapshotIndex | SnapshotPrimaryKey;
type MigrationSnapshot = { ddl: SnapshotEntity[] };

const migrationsUrl = new URL("../migrations/", import.meta.url);
const migrationsDir = fileURLToPath(migrationsUrl);
const migrationFolderPattern = /^\d{14}_/;

function readLatestSnapshot(): MigrationSnapshot {
  const folders = readdirSync(migrationsDir)
    .filter((name) => migrationFolderPattern.test(name))
    .filter((name) => statSync(new URL(`${name}/`, migrationsUrl)).isDirectory())
    .sort();
  const latest = folders.at(-1);
  if (!latest) throw new Error("expected at least one timestamped migration folder");
  return JSON.parse(
    readFileSync(new URL(`${latest}/snapshot.json`, migrationsUrl), "utf8"),
  ) as MigrationSnapshot;
}

const snapshot = readLatestSnapshot();
const snapshotTables = snapshot.ddl.filter((entity): entity is SnapshotTable => entity.entityType === "tables");
const snapshotColumns = snapshot.ddl.filter((entity): entity is SnapshotColumn => entity.entityType === "columns");
const snapshotIndexes = snapshot.ddl.filter((entity): entity is SnapshotIndex => entity.entityType === "indexes");
const snapshotPrimaryKeys = snapshot.ddl.filter((entity): entity is SnapshotPrimaryKey => entity.entityType === "pks");

const tableConfigs = Object.values(schema)
  .filter((value) => is(value, PgTable))
  .map((table) => getTableConfig(table as PgTable))
  .sort((left, right) => left.name.localeCompare(right.name));

function snapshotDefaultFor(column: AnyPgColumn): string | null | undefined {
  if (!column.hasDefault) return null;
  const value = column.default;
  // SQL defaults such as now() are dialect-rendered. Presence is the stable
  // contract here; literal defaults below can be compared byte-for-byte.
  if (value === undefined || is(value, SQL)) return undefined;
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `'${JSON.stringify(value)}'`;
}

function normalizeSqlType(value: string): string {
  // Drizzle's runtime printer includes a space before precision while the
  // drizzle-kit 1.0 snapshot serializer omits it (`timestamp (3)` vs
  // `timestamp(3)`). PostgreSQL treats both spellings identically.
  return value.replace(/\s+\(/g, "(");
}

describe("database schema contract", () => {
  it("keeps every Drizzle table and column aligned with the latest migration snapshot", () => {
    expect(tableConfigs.map((table) => table.name)).toEqual(
      snapshotTables.map((table) => table.name).sort(),
    );

    for (const table of tableConfigs) {
      const migratedColumns = snapshotColumns
        .filter((column) => column.table === table.name)
        .sort((left, right) => left.name.localeCompare(right.name));
      const declaredColumns = [...table.columns]
        .sort((left, right) => left.name.localeCompare(right.name));

      expect(
        declaredColumns.map((column) => column.name),
        `${table.name} column set`,
      ).toEqual(migratedColumns.map((column) => column.name));

      for (const column of declaredColumns) {
        const migrated = migratedColumns.find((candidate) => candidate.name === column.name);
        expect(migrated, `${table.name}.${column.name} must exist in the latest snapshot`).toBeDefined();
        expect(
          normalizeSqlType(migrated?.type ?? ""),
          `${table.name}.${column.name} SQL type`,
        ).toBe(normalizeSqlType(column.getSQLType()));
        expect(migrated?.notNull, `${table.name}.${column.name} nullability`).toBe(column.notNull);
        expect(
          migrated?.default !== null,
          `${table.name}.${column.name} default presence`,
        ).toBe(column.hasDefault);

        const literalDefault = snapshotDefaultFor(column);
        if (literalDefault !== undefined) {
          expect(migrated?.default, `${table.name}.${column.name} default`).toBe(literalDefault);
        }
      }

      const declaredPrimary = declaredColumns
        .filter((column) => column.primary)
        .map((column) => column.name)
        .sort();
      const migratedPrimary = snapshotPrimaryKeys
        .find((key) => key.table === table.name)
        ?.columns
        .toSorted() ?? [];
      expect(declaredPrimary, `${table.name} primary key`).toEqual(migratedPrimary);
    }
  });

  it("keeps declared index names aligned with the latest migration snapshot", () => {
    const declared = tableConfigs
      .flatMap((table) => table.indexes.map((index) => index.config.name))
      .filter((name): name is string => typeof name === "string")
      .sort();
    const migrated = snapshotIndexes.map((index) => index.name).sort();
    expect(declared).toEqual(migrated);
  });

  it("preserves the hot-path index shapes used by recovery and durable repair", () => {
    const expected: Record<string, { table: string; columns: string[]; where?: string }> = {
      audit_logs_org_action_created_idx: {
        table: "audit_logs",
        columns: ["org_id", "action", "created_at"],
      },
      dead_letters_org_run_node_created_idx: {
        table: "dead_letters",
        columns: ["org_id", "run_id", "node_id", "created_at"],
      },
      dead_letters_org_status_idx: {
        table: "dead_letters",
        columns: ["org_id", "status", "created_at"],
      },
      memory_entries_org_retain_until_idx: {
        table: "memory_entries",
        columns: ["org_id", "retain_until"],
      },
      recovery_items_org_status_sla_idx: {
        table: "recovery_items",
        columns: ["org_id", "status", "sla_target_at"],
      },
      run_nodes_queue_publication_repair_idx: {
        table: "run_nodes",
        columns: ["queue_publication_repair_after", "run_id", "node_id"],
        where: `"queue_publication_repair_after" IS NOT NULL AND "status" IN ('pending', 'queued')`,
      },
      runs_parent_notification_idx: {
        table: "runs",
        columns: ["parent_notification_after", "id"],
        where: `"parent_notification_after" IS NOT NULL`,
      },
      trigger_events_backfill_claim_idx: {
        table: "trigger_events",
        columns: ["org_id", "workflow_id", "backfill_claimed_at"],
        where: `"status" = 'backfilling'`,
      },
    };

    for (const [name, contract] of Object.entries(expected)) {
      const index = snapshotIndexes.find((candidate) => candidate.name === name);
      expect(index, `${name} must exist`).toBeDefined();
      expect(index?.table, `${name} table`).toBe(contract.table);
      expect(index?.columns.map((column) => column.value), `${name} columns`).toEqual(contract.columns);
      expect(index?.where ?? undefined, `${name} predicate`).toBe(contract.where);
    }
  });

  it("keeps closed lifecycle defaults inside their persisted contracts", () => {
    const defaults = {
      "dead_letters.status": "'open'",
      "experiments.status": "'pending'",
      "mcp_connections.status": "'pending'",
      "onboarding_progress.status": "'active'",
      "recovery_items.severity": "'p3'",
      "recovery_items.status": "'open'",
      "trigger_events.status": "'received'",
      "workflow_improvements.status": "'pending'",
      "workflows.status": "'active'",
    } as const;

    for (const [path, expectedDefault] of Object.entries(defaults)) {
      const [table, column] = path.split(".");
      const migrated = snapshotColumns.find(
        (candidate) => candidate.table === table && candidate.name === column,
      );
      expect(migrated, `${path} must exist`).toBeDefined();
      expect(migrated?.notNull, `${path} must be required`).toBe(true);
      expect(migrated?.default, `${path} default`).toBe(expectedDefault);
    }
  });
});
