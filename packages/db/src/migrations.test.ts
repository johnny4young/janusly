import { readdirSync, statSync } from "node:fs";
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

});
