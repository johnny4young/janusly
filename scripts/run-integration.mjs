/**
 * Integration-lane runner — the Compose lifecycle for `pnpm test:integration`.
 *
 * Boots ONLY Postgres (the integration tests need no API / worker / Redis /
 * Playwright), applies migrations, runs `@janusly/data`'s `*.integration.test.ts`
 * against that real DB, then tears Compose down. Mirrors scripts/run-e2e.mjs's
 * lifecycle but far lighter, so local and CI behave identically.
 *
 * Usage:
 *   pnpm test:integration
 *
 * CI folds the SAME vitest invocation into the test_e2e job (Compose already
 * up there) via `pnpm --filter @janusly/data test:integration`, so this
 * standalone runner is the LOCAL entry point.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`))));
    child.on("error", reject);
  });
}

async function waitForPostgres(timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn("docker", ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "postgres"], {
          cwd: rootDir,
          stdio: "ignore",
        });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pg_isready exited ${code}`))));
        child.on("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError ?? new Error("postgres did not become ready");
}

async function composeDown() {
  try {
    await run("docker", ["compose", "down"]);
  } catch (error) {
    console.error("[integration] docker compose down failed:", error.message);
  }
}

async function main() {
  let failed = false;
  try {
    console.log("[integration] docker compose up -d --renew-anon-volumes postgres");
    await run("docker", ["compose", "up", "-d", "--renew-anon-volumes", "postgres"]);
    console.log("[integration] waiting for postgres...");
    await waitForPostgres();
    console.log("[integration] pnpm migrate");
    await run("pnpm", ["migrate"]);
    console.log("[integration] running data integration tests");
    await run("pnpm", ["--filter", "@janusly/data", "test:integration"]);
  } catch (error) {
    failed = true;
    console.error("[integration] failed:", error.message);
  } finally {
    await composeDown();
  }
  process.exit(failed ? 1 : 0);
}

main();
