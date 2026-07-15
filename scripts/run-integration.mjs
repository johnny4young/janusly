/**
 * Integration-lane runner — the Compose lifecycle for `pnpm test:integration`.
 *
 * Boots Postgres and Redis, applies migrations, runs each package's
 * `*.integration.test.ts` suite against the real backing services, then tears
 * Compose down. Mirrors scripts/run-e2e.mjs's lifecycle but stays far lighter,
 * so local and CI behave identically. It shares the host-global lifecycle lock
 * with dev, local evals, and E2E because they own the same ports and project.
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
import { acquireJanuslyComposeLock, composeUpPullArgs } from "./process-lock.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const children = new Set();
let shutdownPromise = null;
let composeStarted = false;
let releaseComposeLock = null;
let lockAcquisitionPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processTreeIsAlive(child) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processTreeIsAlive(child) && Date.now() < deadline) await sleep(25);
  const exited = !processTreeIsAlive(child);
  if (exited) children.delete(child);
  return exited;
}

function trackChild(child) {
  children.add(child);
  child.once("exit", () => {
    // The group can outlive its leader; keep observing until the final
    // descendant exits so a stale entry cannot later target a reused PGID.
    void waitForProcessTreeExit(child, Number.POSITIVE_INFINITY);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (shutdownPromise && !options.allowDuringShutdown) {
      reject(new Error(`refusing to start ${command} during integration shutdown`));
      return;
    }
    const child = spawn(command, args, {
      cwd: rootDir,
      detached: true,
      env: { ...process.env, ...options.env },
      stdio: options.stdio ?? "inherit",
    });
    trackChild(child);
    let timedOut = false;
    const timeout = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      void (async () => {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Re-check below.
        }
        if (!await waitForProcessTreeExit(child, 2_000)) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Re-check below.
          }
          await waitForProcessTreeExit(child, 2_000);
        }
        reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
      })();
    }, options.timeoutMs) : null;
    child.on("exit", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      void waitForProcessTreeExit(child, 5_000).then((exited) => {
        if (timedOut) return;
        if (!exited) reject(new Error(`${command} ${args.join(" ")} left a live descendant process`));
        else if (code === 0) resolve();
        else reject(new Error(
          `${command} ${args.join(" ")} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        ));
      }, reject);
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) return;
      if (!processTreeIsAlive(child)) children.delete(child);
      reject(error);
    });
  });
}

async function waitForPostgres(timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await run(
        "docker",
        ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "postgres"],
        { stdio: "ignore" },
      );
      return;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError ?? new Error("postgres did not become ready");
}

async function waitForRedis(timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await run(
        "docker",
        ["compose", "exec", "-T", "redis", "redis-cli", "ping"],
        { stdio: "ignore" },
      );
      return;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError ?? new Error("redis did not become ready");
}

async function stopProcessTree(child) {
  if (!child || !processTreeIsAlive(child)) {
    children.delete(child);
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Re-check below.
  }
  if (await waitForProcessTreeExit(child, 5_000)) {
    children.delete(child);
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Re-check below.
  }
  if (await waitForProcessTreeExit(child, 2_000)) {
    children.delete(child);
    return;
  }
  throw new Error(`failed to stop integration process tree ${child.pid ?? "unknown"}`);
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    let teardownComplete = false;
    try {
      if (lockAcquisitionPromise) await lockAcquisitionPromise.catch(() => {});
      const stopResults = await Promise.allSettled([...children].map(stopProcessTree));
      const teardownErrors = stopResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (composeStarted) {
        try {
          await run("docker", ["compose", "down"], {
            allowDuringShutdown: true,
            timeoutMs: 30_000,
          });
          composeStarted = false;
        } catch (error) {
          teardownErrors.push(error);
        }
      }
      if (teardownErrors.length > 0) {
        throw new AggregateError(teardownErrors, "integration teardown did not fully drain");
      }
      teardownComplete = true;
    } finally {
      if (teardownComplete) {
        const release = releaseComposeLock;
        releaseComposeLock = null;
        if (release) await release();
      }
    }
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown()
      .catch((error) => console.error("[integration] shutdown failed", error))
      .finally(() => process.exit(130));
  });
}

async function acquireComposeLease() {
  lockAcquisitionPromise = acquireJanuslyComposeLock().then(async (release) => {
    if (shutdownPromise) {
      await release();
      throw new Error("integration shutdown began while acquiring the Compose lifecycle lock");
    }
    releaseComposeLock = release;
    return release;
  });
  await lockAcquisitionPromise;
}

async function finishShutdown() {
  try {
    await shutdown();
    return true;
  } catch (error) {
    console.error(
      "[integration] shutdown failed:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function main() {
  let failed = false;
  try {
    await acquireComposeLease();
    console.log("[integration] docker compose up -d --renew-anon-volumes redis postgres");
    composeStarted = true;
    await run(
      "docker",
      [
        "compose",
        "up",
        ...composeUpPullArgs(),
        "-d",
        "--renew-anon-volumes",
        "redis",
        "postgres",
      ],
      { timeoutMs: 5 * 60_000 },
    );
    console.log("[integration] waiting for postgres and redis...");
    await Promise.all([waitForPostgres(), waitForRedis()]);
    console.log("[integration] pnpm migrate");
    await run("pnpm", ["migrate"]);
    console.log("[integration] running data integration tests");
    await run("pnpm", ["--filter", "@janusly/data", "test:integration"]);
    console.log("[integration] running api integration tests");
    await run("pnpm", ["--filter", "@janusly/api", "test:integration"]);
    console.log("[integration] running engine integration tests");
    await run("pnpm", ["--filter", "@janusly/engine", "test:integration"]);
  } catch (error) {
    failed = true;
    console.error("[integration] failed:", error instanceof Error ? error.message : String(error));
  } finally {
    if (!await finishShutdown()) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

main();
