import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  computeMigrationFingerprint,
  readDeclaredPublicTables,
  validateBackupManifest,
  verifyBackupDirectory,
} from "./local-backup.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "janusly-backup-"));
  await chmod(root, 0o700);
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const migrations = join(root, "migrations");
  await mkdir(join(migrations, "001"), { recursive: true });
  await writeFile(join(migrations, "001", "migration.sql"), "CREATE TABLE example(id text);\n");
  const database = "COPY public.example (id) FROM stdin;\nvalue\n\\.\n";
  const key = "private-root-key\n";
  await writeFile(join(root, "database.sql"), database, { mode: 0o600 });
  await writeFile(join(root, "credential-master.key"), key, { mode: 0o600 });
  const manifest = {
    format: 1,
    projectId: "janusly-local",
    createdAt: "2026-07-30T00:00:00.000Z",
    gitCommit: "a".repeat(40),
    migrationFingerprint: await computeMigrationFingerprint(migrations),
    databaseSha256: sha256(database),
    credentialKeySha256: sha256(key),
    rowCounts: {
      authUsers: 1,
      organizations: 1,
      workflows: 1,
      runs: 1,
      credentialSecretVersions: 1,
    },
    excludedPublicTables: [],
    excludedAuthTables: ["schema_migrations"],
    ...overrides,
  };
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await chmod(root, 0o700);
  return { root, migrations, manifest };
}

test("validates a complete backup before any destructive restore", async (t) => {
  const { root, migrations, manifest } = await fixture(t);
  const verified = await verifyBackupDirectory(root, { migrationsDirectory: migrations });
  assert.deepEqual(verified.manifest, manifest);
});

test("rejects a modified database dump", async (t) => {
  const { root, migrations } = await fixture(t);
  await writeFile(join(root, "database.sql"), "tampered\n");
  await assert.rejects(
    verifyBackupDirectory(root, { migrationsDirectory: migrations }),
    /database backup checksum mismatch/,
  );
});

test("rejects symlinked backup artifacts", async (t) => {
  const { root, migrations } = await fixture(t);
  const databasePath = join(root, "database.sql");
  const movedPath = join(root, "database-moved.sql");
  await rename(databasePath, movedPath);
  await symlink(movedPath, databasePath);
  await assert.rejects(
    verifyBackupDirectory(root, { migrationsDirectory: migrations }),
    /database\.sql must be a regular file/,
  );
});

test("rejects a backup created for a different migration set", async (t) => {
  const { root, migrations } = await fixture(t);
  await writeFile(join(migrations, "001", "migration.sql"), "CREATE TABLE changed(id text);\n");
  await assert.rejects(
    verifyBackupDirectory(root, { migrationsDirectory: migrations }),
    /backup migrations do not match/,
  );
});

test("rejects malformed or foreign manifests", () => {
  assert.throws(() => validateBackupManifest({ format: 1 }), /belongs to/);
  assert.throws(
    () => validateBackupManifest({
      format: 2,
      projectId: "janusly-local",
    }),
    /unsupported backup format/,
  );
});

test("reads declared public tables from every schema domain module", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "janusly-schema-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "executions.ts"), 'export const runs = pgTable("runs", {});\n');
  await writeFile(join(root, "workflows.ts"), 'export const workflows = pgTable(\n  "workflows",\n  {},\n);\n');
  await writeFile(join(root, "README.md"), 'pgTable("ignored", {});\n');

  assert.deepEqual(
    [...await readDeclaredPublicTables(root)].sort(),
    ["runs", "workflows"],
  );
});

test("reads the complete current schema inventory", async () => {
  assert.equal((await readDeclaredPublicTables()).size, 71);
});

test("rejects empty or duplicate schema inventories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "janusly-schema-invalid-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(readDeclaredPublicTables(root), /did not declare any public tables/);
  await writeFile(join(root, "one.ts"), 'export const one = pgTable("same", {});\n');
  await writeFile(join(root, "two.ts"), 'export const two = pgTable("same", {});\n');
  await assert.rejects(readDeclaredPublicTables(root), /duplicate public tables: same/);
});
