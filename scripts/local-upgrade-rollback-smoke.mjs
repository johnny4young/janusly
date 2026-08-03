/** Destructive forward-migration and previous-application rollback qualification. */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import {
  ensureLocalCredentialMasterKey,
  ensureLocalEnv,
  getLocalStackSettings,
  localCredentialKeyFile,
  localEnvFile,
} from "./local-env.mjs";
import {
  startLocalSupabase,
} from "./local-supabase.mjs";
import {
  assertUpgradeQualificationRequest,
  validateMigrationUpgrade,
} from "./local-upgrade-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDirectory = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(new URL("../output/review/local-upgrade-rollback", import.meta.url));
const baselineSource = join(evidenceDirectory, `.baseline-source-${process.pid}`);
const baselineArchive = join(evidenceDirectory, `.baseline-source-${process.pid}.tar`);
const databaseContainer = "supabase_db_janusly-local";
const stackImages = [
  "janusly-local-api",
  "janusly-local-worker",
  "janusly-local-web",
  "janusly-local-provider-simulator",
];
const stamp = `${Date.now()}-${process.pid}`;
const identityEnvironment = {
  JANUSLY_UPGRADE_EMAIL: `owner-${stamp}@upgrade.janusly.test`,
  JANUSLY_UPGRADE_PASSWORD: `Upgrade-${stamp}-Identity!`,
  JANUSLY_UPGRADE_ORG_NAME: `Upgrade Lab ${stamp}`,
  JANUSLY_UPGRADE_WORKFLOW_ID: `upgrade-workflow-${stamp}`,
  JANUSLY_UPGRADE_WORKFLOW_NAME: `Upgrade workflow ${stamp}`,
};

assertUpgradeQualificationRequest(process.argv.slice(2));
await mkdir(evidenceDirectory, { recursive: true });
await ensureLocalEnv();
await ensureLocalCredentialMasterKey();
const settings = await getLocalStackSettings();

function run(command, argumentsList, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const output = options.stdoutFile
      ? createWriteStream(options.stdoutFile, { mode: 0o600 })
      : null;
    const capture = options.capture || options.sensitive;
    const child = spawn(command, argumentsList, {
      cwd: options.cwd ?? root,
      stdio: [
        "ignore",
        output ? "pipe" : capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
      env: { ...process.env, ...identityEnvironment, ...options.environment },
    });
    let outputError;
    const outputFinished = output
      ? finished(child.stdout.pipe(output)).catch((error) => {
        outputError = error;
      })
      : Promise.resolve();
    let stdout = "";
    let stderr = "";
    if (!output) child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", async (code) => {
      try {
        await outputFinished;
        if (outputError) throw outputError;
        if (code === 0) {
          resolvePromise({ stdout, stderr });
          return;
        }
        reject(new Error(
          `${command} ${argumentsList.join(" ")} exited ${code}${!options.sensitive && stderr ? `: ${stderr.trim()}` : ""}`,
        ));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function git(...argumentsList) {
  return (await run("git", argumentsList, { capture: true })).stdout.trim();
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function listMigrations(sourceRoot) {
  const directory = join(sourceRoot, "packages/db/migrations");
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, "migration.sql");
    try {
      migrations.push({
        path: relative(sourceRoot, path),
        sha256: await sha256(path),
      });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return migrations;
}

async function findBaselineRef() {
  if (process.env.JANUSLY_UPGRADE_BASE_REF?.trim()) {
    return git("rev-parse", `${process.env.JANUSLY_UPGRADE_BASE_REF.trim()}^{commit}`);
  }
  const history = await git(
    "rev-list",
    "--first-parent",
    "HEAD",
    "--",
    "packages/db/migrations",
  );
  const newestMigrationCommit = history.split(/\r?\n/u).find(Boolean);
  if (!newestMigrationCommit) {
    throw new Error("could not find a historical migration commit");
  }
  return git("rev-parse", `${newestMigrationCommit}^`);
}

async function exportBaseline(ref) {
  await rm(baselineSource, { recursive: true, force: true });
  await rm(baselineArchive, { force: true });
  await mkdir(baselineSource, { recursive: true });
  await run("git", [
    "archive",
    "--format=tar",
    `--output=${baselineArchive}`,
    ref,
  ]);
  await run("tar", ["-xf", baselineArchive, "-C", baselineSource]);

  const packageJson = JSON.parse(
    await readFile(join(baselineSource, "package.json"), "utf8"),
  );
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)/u.exec(packageJson.packageManager)?.[1];
  if (!pnpmVersion) throw new Error("baseline packageManager does not pin pnpm");

  const compatibilityPatches = [];
  for (const name of ["Dockerfile.prod", "Dockerfile.web"]) {
    const path = join(baselineSource, name);
    const source = await readFile(path, "utf8");
    if (!source.includes("RUN corepack enable")) continue;
    await writeFile(
      path,
      source.replaceAll(
        "RUN corepack enable",
        `RUN npm install --global pnpm@${pnpmVersion}`,
      ),
    );
    compatibilityPatches.push(name);
  }

  await copyFile(join(root, localEnvFile), join(baselineSource, localEnvFile));
  const baselineKey = join(baselineSource, localCredentialKeyFile);
  await mkdir(dirname(baselineKey), { recursive: true, mode: 0o700 });
  await copyFile(join(root, localCredentialKeyFile), baselineKey);
  await Promise.all([
    chmod(join(baselineSource, localEnvFile), 0o600),
    chmod(dirname(baselineKey), 0o700),
    chmod(baselineKey, 0o600),
  ]);
  return { compatibilityPatches, pnpmVersion };
}

function compose(sourceRoot, argumentsList, environment) {
  return run(
    "docker",
    [
      "compose",
      "--env-file",
      localEnvFile,
      "-f",
      "deploy/local/compose.yml",
      ...argumentsList,
    ],
    { cwd: sourceRoot, environment },
  );
}

async function waitFor(url, timeoutMs = 240_000) {
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

async function waitForStack() {
  await Promise.all([
    waitFor(`${settings.apiUrl}/health`),
    waitFor(`${settings.webUrl}/`),
    waitFor(`${settings.simulatorUrl}/health`),
  ]);
}

async function runBrowserPhase(phase) {
  await run(
    "pnpm",
    [
      "--filter", "@janusly/web", "exec", "playwright", "test",
      "e2e/local-upgrade-rollback.spec.ts", "--project=chromium", "--workers=1",
    ],
    {
      environment: {
        JANUSLY_LOCAL_UPGRADE_E2E: "1",
        JANUSLY_UPGRADE_PHASE: phase,
        JANUSLY_UPGRADE_API_URL: settings.apiUrl,
        JANUSLY_EVIDENCE_DIR: evidenceDirectory,
        PLAYWRIGHT_BASE_URL: settings.webUrl,
        PLAYWRIGHT_SKIP_WEB_SERVER: "1",
      },
    },
  );
}

async function queryState() {
  const sql = `
    SELECT json_build_object(
      'authUsers', (SELECT count(*)::int FROM auth.users),
      'januslyUsers', (SELECT count(*)::int FROM public.users),
      'organizations', (SELECT count(*)::int FROM public.organizations),
      'workflows', (SELECT count(*)::int FROM public.workflows),
      'workflowVersions', (SELECT count(*)::int FROM public.workflow_versions),
      'runs', (SELECT count(*)::int FROM public.runs),
      'migrationRows', (SELECT count(*)::int FROM drizzle.__drizzle_migrations),
      'externalTables', (
        SELECT count(*)::int
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = ANY (ARRAY[
            'external_runtime_connections',
            'external_runtime_events',
            'external_workflows',
            'external_runs',
            'external_run_steps',
            'external_recovery_cases'
          ])
      )
    )::text;
  `;
  const { stdout } = await run(
    "docker",
    [
      "exec", databaseContainer,
      "psql", "-At", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-c", sql,
    ],
    { capture: true },
  );
  return JSON.parse(stdout.trim());
}

function assertApplicationData(state, context) {
  for (const key of [
    "authUsers",
    "januslyUsers",
    "organizations",
    "workflows",
    "workflowVersions",
    "runs",
  ]) {
    if (state[key] !== 1) {
      throw new Error(`${context} expected ${key}=1, received ${JSON.stringify(state)}`);
    }
  }
}

async function snapshotDatabase(path) {
  await run(
    "docker",
    [
      "exec", databaseContainer,
      "pg_dump", "-U", "postgres", "-d", "postgres",
      "--format=custom", "--no-owner", "--no-privileges",
      "--schema=auth", "--schema=public", "--schema=drizzle",
      "--exclude-table=auth.schema_migrations",
    ],
    { stdoutFile: path, capture: true },
  );
  await chmod(path, 0o600);
}

async function tagBaselineImages(shortRef) {
  const tags = {};
  for (const image of stackImages) {
    const tag = `${image}:upgrade-baseline-${shortRef}`;
    await run("docker", ["image", "tag", `${image}:latest`, tag]);
    tags[image] = tag;
  }
  return tags;
}

async function restoreBaselineTags(tags) {
  for (const [image, tag] of Object.entries(tags)) {
    await run("docker", ["image", "tag", tag, `${image}:latest`]);
  }
}

async function removeBaselineTags(tags) {
  const retainedTags = Object.values(tags);
  if (retainedTags.length === 0) return;
  await run("docker", ["image", "rm", ...retainedTags], { capture: true });
}

const currentRef = await git("rev-parse", "HEAD");
const currentWorkingTreeDirty = Boolean(
  await git("status", "--porcelain=v1", "--untracked-files=all"),
);
const baselineRef = await findBaselineRef();
await run("git", ["merge-base", "--is-ancestor", baselineRef, currentRef]);
const shortBaselineRef = baselineRef.slice(0, 12);
const preUpgradeBackup = join(evidenceDirectory, "pre-upgrade-database.dump");

let composeEnvironment;
let baselineImageTags = {};
let report;
let primaryError;
try {
  const baselineBuild = await exportBaseline(baselineRef);
  const [baselineMigrations, currentMigrations] = await Promise.all([
    listMigrations(baselineSource),
    listMigrations(root),
  ]);
  const addedMigrations = validateMigrationUpgrade(
    baselineMigrations,
    currentMigrations,
  );

  await run(process.execPath, ["scripts/local-stack.mjs", "reset", "--auth"]);
  composeEnvironment = await startLocalSupabase({ authEnabled: true });
  await compose(baselineSource, ["up", "-d", "--build"], composeEnvironment);
  await waitForStack();
  baselineImageTags = await tagBaselineImages(shortBaselineRef);

  await runBrowserPhase("baseline");
  const baselineState = await queryState();
  assertApplicationData(baselineState, "baseline");
  if (
    baselineState.migrationRows !== baselineMigrations.length
    || baselineState.externalTables !== 0
  ) {
    throw new Error(`baseline migration boundary is invalid: ${JSON.stringify(baselineState)}`);
  }
  await snapshotDatabase(preUpgradeBackup);

  await compose(baselineSource, ["down"], composeEnvironment);
  await run(process.execPath, ["scripts/local-stack.mjs", "up", "--auth"]);
  await runBrowserPhase("upgraded");
  const upgradedState = await queryState();
  assertApplicationData(upgradedState, "upgraded");
  if (
    upgradedState.migrationRows !== currentMigrations.length
    || upgradedState.externalTables !== 6
  ) {
    throw new Error(`forward migration boundary is invalid: ${JSON.stringify(upgradedState)}`);
  }

  await compose(root, ["down"], composeEnvironment);
  await restoreBaselineTags(baselineImageTags);
  await compose(baselineSource, ["up", "-d", "--no-build"], composeEnvironment);
  await waitForStack();
  await runBrowserPhase("rollback");
  const rollbackState = await queryState();
  assertApplicationData(rollbackState, "rollback");
  if (
    rollbackState.migrationRows !== currentMigrations.length
    || rollbackState.externalTables !== 6
  ) {
    throw new Error(`application rollback altered the upgraded schema: ${JSON.stringify(rollbackState)}`);
  }

  await compose(baselineSource, ["down"], composeEnvironment);
  await run(process.execPath, ["scripts/local-stack.mjs", "up", "--auth"]);
  await runBrowserPhase("rolled-forward");
  const rolledForwardState = await queryState();
  assertApplicationData(rolledForwardState, "rolled forward");

  report = {
    qualifiedAt: new Date().toISOString(),
    currentSource: {
      headRef: currentRef,
      dirtyAtQualification: currentWorkingTreeDirty,
    },
    baselineRef,
    baselineMigrationCount: baselineMigrations.length,
    currentMigrationCount: currentMigrations.length,
    addedMigrations: addedMigrations.map(({ path }) => path),
    baselineBuild,
    preUpgradeBackup: {
      file: basename(preUpgradeBackup),
      sha256: await sha256(preUpgradeBackup),
    },
    states: {
      baseline: baselineState,
      upgraded: upgradedState,
      rollback: rollbackState,
      rolledForward: rolledForwardState,
    },
    screenshots: [
      "upgrade-baseline-en.png",
      "upgrade-current-en.png",
      "upgrade-current-es.png",
      "upgrade-rollback-en.png",
      "upgrade-rolled-forward-en.png",
    ],
  };
  await writeFile(
    join(evidenceDirectory, "upgrade-rollback.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
} catch (error) {
  primaryError = error;
} finally {
  await rm(baselineSource, { recursive: true, force: true });
  await rm(baselineArchive, { force: true });
  try {
    await run(process.execPath, ["scripts/local-stack.mjs", "reset", "--auth"]);
    await run(process.execPath, ["scripts/local-stack.mjs", "up", "--auth"]);
    await run(
      process.execPath,
      ["scripts/local-stack.mjs", "verify-db", "--auth", "--expect-empty"],
    );
    await removeBaselineTags(baselineImageTags);
  } catch (cleanupError) {
    primaryError = primaryError
      ? new AggregateError([primaryError, cleanupError], "upgrade qualification and cleanup failed")
      : cleanupError;
  }
}

if (primaryError) throw primaryError;
console.log(`[local] upgrade/rollback evidence: ${evidenceDirectory}`);
