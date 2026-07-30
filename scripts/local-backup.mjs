/** Portable backup and restore for the unified local Supabase database. */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ensureLocalCredentialMasterKey,
  localCredentialKeyFile,
} from "./local-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const supabaseCli = fileURLToPath(new URL("../node_modules/supabase/dist/supabase.js", import.meta.url));
const migrationsDirectory = fileURLToPath(new URL("../packages/db/migrations", import.meta.url));
const schemaFile = fileURLToPath(new URL("../packages/db/src/schema.ts", import.meta.url));
const defaultBackupRoot = fileURLToPath(new URL("../output/backups", import.meta.url));
const manifestName = "manifest.json";
const databaseName = "database.sql";
const credentialKeyName = "credential-master.key";
const backupFormat = 1;
const projectId = "janusly-local";
const databaseContainerName = `supabase_db_${projectId}`;
const workloadContainerNames = [
  "janusly-local-web-1",
  "janusly-local-api-1",
  "janusly-local-worker-1",
  `supabase_auth_${projectId}`,
  `supabase_kong_${projectId}`,
];

const summarySql = `
SELECT json_build_object(
  'authUsers', (SELECT count(*) FROM auth.users),
  'organizations', (SELECT count(*) FROM public.organizations),
  'workflows', (SELECT count(*) FROM public.workflows),
  'runs', (SELECT count(*) FROM public.runs),
  'credentialSecretVersions', (SELECT count(*) FROM public.credential_secret_versions)
)::text;
`;

const truncateSql = `
DO $$
DECLARE
  targets text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO targets
    FROM pg_tables
    WHERE schemaname IN ('auth', 'public')
      AND NOT (schemaname = 'auth' AND tablename = 'schema_migrations');
  IF targets IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || targets || ' RESTART IDENTITY CASCADE';
  END IF;
END
$$;
`;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        SUPABASE_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
      },
      stdio: options.inputFile
        ? ["pipe", options.capture ? "pipe" : "inherit", "inherit"]
        : options.capture
          ? ["ignore", "pipe", "pipe"]
          : "inherit",
    });
    if (options.inputFile) {
      const input = createReadStream(options.inputFile);
      input.on("error", (error) => child.stdin.destroy(error));
      input.pipe(child.stdin);
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${basename(command)} ${args.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function runSupabase(args, options = {}) {
  return run(process.execPath, [supabaseCli, ...args], options);
}

async function hashFile(path) {
  const hash = createHash("sha256");
  const input = createReadStream(path);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

async function assertRegularArtifact(path, name) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${name} must be a regular file`);
  }
}

async function listMigrationFiles(directory = migrationsDirectory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const migration = join(directory, entry.name, "migration.sql");
    try {
      if ((await lstat(migration)).isFile()) files.push(migration);
    } catch {
      // Migration folders without migration.sql are not part of the applied schema.
    }
  }
  return files;
}

export async function computeMigrationFingerprint(directory = migrationsDirectory) {
  const hash = createHash("sha256");
  for (const path of await listMigrationFiles(directory)) {
    hash.update(`${basename(resolve(path, ".."))}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isCountSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return ["authUsers", "organizations", "workflows", "runs", "credentialSecretVersions"]
    .every((key) => Number.isInteger(value[key]) && value[key] >= 0);
}

export function validateBackupManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backup manifest must be an object");
  }
  if (value.format !== backupFormat) throw new Error(`unsupported backup format ${String(value.format)}`);
  if (value.projectId !== projectId) throw new Error(`backup belongs to ${String(value.projectId)}, not ${projectId}`);
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("backup manifest has an invalid createdAt");
  }
  for (const key of ["databaseSha256", "credentialKeySha256", "migrationFingerprint"]) {
    if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/u.test(value[key])) {
      throw new Error(`backup manifest has an invalid ${key}`);
    }
  }
  if (typeof value.gitCommit !== "string" || !/^[a-f0-9]{40}$/u.test(value.gitCommit)) {
    throw new Error("backup manifest has an invalid gitCommit");
  }
  if (!isCountSummary(value.rowCounts)) throw new Error("backup manifest has an invalid rowCounts");
  if (
    !Array.isArray(value.excludedPublicTables)
    || value.excludedPublicTables.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]*$/u.test(name))
    || new Set(value.excludedPublicTables).size !== value.excludedPublicTables.length
  ) {
    throw new Error("backup manifest has invalid excludedPublicTables");
  }
  if (
    !Array.isArray(value.excludedAuthTables)
    || value.excludedAuthTables.length !== 1
    || value.excludedAuthTables[0] !== "schema_migrations"
  ) {
    throw new Error("backup manifest has invalid excludedAuthTables");
  }
  return value;
}

export async function verifyBackupDirectory(directory, options = {}) {
  const resolvedDirectory = resolve(directory);
  const directoryStat = await lstat(resolvedDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("backup path must be a real directory");
  }
  const manifestPath = join(resolvedDirectory, manifestName);
  const databasePath = join(resolvedDirectory, databaseName);
  const credentialPath = join(resolvedDirectory, credentialKeyName);
  await Promise.all([
    assertRegularArtifact(manifestPath, manifestName),
    assertRegularArtifact(databasePath, databaseName),
    assertRegularArtifact(credentialPath, credentialKeyName),
  ]);
  const manifest = validateBackupManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const [databaseSha256, credentialKeySha256, migrationFingerprint] = await Promise.all([
    hashFile(databasePath),
    hashFile(credentialPath),
    computeMigrationFingerprint(options.migrationsDirectory),
  ]);
  if (databaseSha256 !== manifest.databaseSha256) throw new Error("database backup checksum mismatch");
  if (credentialKeySha256 !== manifest.credentialKeySha256) throw new Error("credential key checksum mismatch");
  if (migrationFingerprint !== manifest.migrationFingerprint) {
    throw new Error("backup migrations do not match the current checkout");
  }
  return { directory: resolvedDirectory, manifest };
}

async function runningContainers(names = workloadContainerNames) {
  const { stdout } = await run("docker", ["ps", "--format", "{{.Names}}"], { capture: true });
  const running = new Set(stdout.split(/\r?\n/u).filter(Boolean));
  return names.filter((name) => running.has(name));
}

async function stopContainers(names) {
  if (names.length > 0) await run("docker", ["stop", ...names]);
}

async function startContainers(names) {
  if (names.length > 0) await run("docker", ["start", ...names]);
}

async function assertDatabaseRunning() {
  const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Running}}", databaseContainerName], { capture: true });
  if (stdout.trim() !== "true") throw new Error("local Supabase database is not running");
}

async function queryRowCounts() {
  const { stdout } = await run(
    "docker",
    ["exec", databaseContainerName, "psql", "-At", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", summarySql],
    { capture: true },
  );
  const summary = JSON.parse(stdout.trim());
  if (!isCountSummary(summary)) throw new Error("database returned an invalid row-count summary");
  return summary;
}

async function currentPublicTables() {
  const source = await readFile(schemaFile, "utf8");
  return new Set([...source.matchAll(/pgTable\(\s*["']([^"']+)/gu)].map((match) => match[1]));
}

async function queryLivePublicTables() {
  const { stdout } = await run(
    "docker",
    [
      "exec", databaseContainerName, "psql", "-At", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1",
      "-c", "SELECT coalesce(json_agg(tablename ORDER BY tablename), '[]'::json)::text FROM pg_tables WHERE schemaname = 'public';",
    ],
    { capture: true },
  );
  const tables = JSON.parse(stdout.trim());
  if (!Array.isArray(tables) || tables.some((name) => typeof name !== "string")) {
    throw new Error("database returned an invalid public-table inventory");
  }
  return tables;
}

async function gitCommit() {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { capture: true });
  return stdout.trim();
}

function timestampName(now = new Date()) {
  return `janusly-local-${now.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z")}`;
}

async function backup(destination) {
  await assertDatabaseRunning();
  await ensureLocalCredentialMasterKey();
  const directory = resolve(destination ?? join(defaultBackupRoot, timestampName()));
  await mkdir(resolve(directory, ".."), { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await chmod(directory, 0o700);

  const databasePath = join(directory, databaseName);
  const credentialPath = join(directory, credentialKeyName);
  const stopped = await runningContainers();
  try {
    await stopContainers(stopped);
    const [declaredTables, liveTables] = await Promise.all([
      currentPublicTables(),
      queryLivePublicTables(),
    ]);
    const excludedPublicTables = liveTables
      .filter((table) => !declaredTables.has(table))
      .sort((left, right) => left.localeCompare(right));
    const missingPublicTables = [...declaredTables]
      .filter((table) => !liveTables.includes(table))
      .sort((left, right) => left.localeCompare(right));
    if (missingPublicTables.length > 0) {
      throw new Error(`local database is missing declared tables: ${missingPublicTables.join(", ")}`);
    }
    const dumpArguments = [
      "db", "dump", "--local", "--data-only", "--use-copy",
      "--schema", "auth,public", "--file", databasePath,
      "--exclude", "auth.schema_migrations",
    ];
    for (const table of excludedPublicTables) {
      dumpArguments.push("--exclude", `public.${table}`);
    }
    await runSupabase(dumpArguments);
    await copyFile(resolve(root, localCredentialKeyFile), credentialPath);
    await Promise.all([chmod(databasePath, 0o600), chmod(credentialPath, 0o600)]);
    const [databaseSha256, credentialKeySha256, migrationFingerprint, commit, rowCounts] = await Promise.all([
      hashFile(databasePath),
      hashFile(credentialPath),
      computeMigrationFingerprint(),
      gitCommit(),
      queryRowCounts(),
    ]);
    const manifest = {
      format: backupFormat,
      projectId,
      createdAt: new Date().toISOString(),
      gitCommit: commit,
      migrationFingerprint,
      databaseSha256,
      credentialKeySha256,
      rowCounts,
      excludedPublicTables,
      excludedAuthTables: ["schema_migrations"],
    };
    const manifestPath = join(directory, manifestName);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await chmod(manifestPath, 0o600);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await startContainers(stopped);
  }
  await Promise.all([
    waitFor("http://127.0.0.1:7311/health"),
    waitFor("http://127.0.0.1:7310/"),
    waitForContainerHealthy(`supabase_auth_${projectId}`),
    waitForContainerHealthy(`supabase_kong_${projectId}`),
  ]);
  console.log(`[local] backup created at ${directory}`);
  console.log("[local] the directory contains authentication data and a credential root key; keep it private");
  return directory;
}

async function applySql(sql) {
  await run(
    "docker",
    ["exec", "-i", databaseContainerName, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql],
  );
}

async function applySqlFile(path) {
  await run(
    "docker",
    ["exec", "-i", databaseContainerName, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { inputFile: path },
  );
}

async function waitFor(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

async function waitForContainerHealthy(name, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "missing";
  while (Date.now() < deadline) {
    try {
      const { stdout } = await run(
        "docker",
        ["inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", name],
        { capture: true },
      );
      lastStatus = stdout.trim();
      if (lastStatus === "healthy" || lastStatus === "running") return;
    } catch {
      lastStatus = "missing";
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`${name} did not become healthy (last status: ${lastStatus})`);
}

async function restore(source, confirmed) {
  if (!source) throw new Error("usage: pnpm local:restore -- <backup-directory> --confirm-reset");
  if (!confirmed) {
    throw new Error("restore is destructive; repeat with --confirm-reset after verifying the backup path");
  }
  const { directory, manifest } = await verifyBackupDirectory(source);
  await run(process.execPath, ["scripts/local-stack.mjs", "reset", "--auth"]);

  const keyTarget = resolve(root, localCredentialKeyFile);
  const keyTemporary = `${keyTarget}.restore-${process.pid}`;
  await copyFile(join(directory, credentialKeyName), keyTemporary);
  await chmod(keyTemporary, 0o600);
  await rename(keyTemporary, keyTarget);

  await run(process.execPath, ["scripts/local-stack.mjs", "up", "--auth"]);
  const stopped = await runningContainers();
  await stopContainers(stopped);
  try {
    await applySql(truncateSql);
    await applySqlFile(join(directory, databaseName));
    const restoredCounts = await queryRowCounts();
    if (JSON.stringify(restoredCounts) !== JSON.stringify(manifest.rowCounts)) {
      throw new Error(`restored row counts differ: expected ${JSON.stringify(manifest.rowCounts)}, got ${JSON.stringify(restoredCounts)}`);
    }
  } catch (error) {
    console.error("[local] restore failed with application and Auth containers stopped; inspect the database before restarting");
    throw error;
  }
  await startContainers(stopped);
  await Promise.all([
    waitFor("http://127.0.0.1:7311/health"),
    waitFor("http://127.0.0.1:7310/"),
    waitForContainerHealthy(`supabase_auth_${projectId}`),
    waitForContainerHealthy(`supabase_kong_${projectId}`),
  ]);
  console.log(`[local] restored ${directory}`);
  console.log(`[local] verified rows ${JSON.stringify(manifest.rowCounts)}`);
}

async function main() {
  const [command, source] = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  if (command === "backup") {
    await backup(source);
    return;
  }
  if (command === "restore") {
    await restore(source, process.argv.includes("--confirm-reset"));
    return;
  }
  throw new Error("usage: node scripts/local-backup.mjs backup [directory] | restore <directory> --confirm-reset");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
