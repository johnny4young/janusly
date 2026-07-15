/**
 * One-command LOCAL golden-eval regression gate.
 *
 * Boots the minimum stack needed to run the AI workflow-generation golden
 * runs against a real API, runs them, and tears everything down — so a
 * developer can check `evals/generate-workflow.jsonl` for regressions with a
 * single command instead of remembering to start `pnpm dev` first.
 *
 * Lifecycle:
 *   1. acquire the host-global Janusly Compose lifecycle lock
 *   2. `docker compose up -d --renew-anon-volumes redis postgres`
 *   3. wait for Postgres to accept connections (`pg_isready`)
 *   4. `pnpm migrate` — applies the Drizzle migrations from packages/db
 *   5. spawn `apps/api` only (detached process group) on PORT 3001
 *   6. wait for the API to answer `GET /tools` with dev headers
 *   7. run `scripts/run-evals.mjs` against it (non-zero exit on regression)
 *   8. on failure: dump `docker compose logs` for the postmortem
 *   9. always: drain process groups + Compose, then release the lock
 *
 * Used by:
 * - root `package.json` `evals:local` script (`pnpm evals:local`)
 *
 * Invariants:
 * - LOCAL-ONLY by design. This is intentionally NOT wired into
 *   `.github/workflows/ci.yml`: the golden runs call the AI provider, which
 *   spends credits on every invocation. Keep this developer-invoked — do not
 *   add it to CI without first scoping a cost-bounded approach.
 * - Only spends AI credits when a configured LLM provider key is reachable.
 *   With no key the `requiresMode: "ai"` cases skip (not fail) and the
 *   deterministic cases still gate — so a no-key run is green and costs
 *   nothing.
 * - Mirrors the Compose lifecycle of `scripts/run-e2e.mjs` (the repo's
 *   "mirror, don't share" convention for these orchestrators). The one
 *   intentional deviation: only the API is booted — the eval suite hits
 *   exclusively the synchronous `/ai/generate-workflow` route, which does no
 *   queue/worker work, so the worker would be dead weight.
 * - Always runs `docker compose down` on exit (AGENTS.md Compose lifecycle).
 * - Postgres / Redis data must be clean for every run. Mirror the e2e runner
 *   by renewing anonymous volumes on startup instead of using `down -v`, which
 *   would delete the named Ollama model cache used by `pnpm dev`.
 * - SIGINT/SIGTERM handlers tear the stack down rather than orphaning
 *   containers.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireJanuslyComposeLock, composeUpPullArgs } from "./process-lock.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const apiUrl = "http://127.0.0.1:3001";
const children = new Set();
let shutdownPromise = null;
let composeStarted = false;
let releaseComposeLock = null;
let lockAcquisitionPromise = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      reject(new Error(`refusing to start ${command} during eval shutdown`));
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

function startService(name, command, args, options = {}) {
  if (shutdownPromise) throw new Error(`refusing to start ${name} during eval shutdown`);
  const child = spawn(command, args, {
    cwd: rootDir,
    detached: true,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });

  child.serviceName = name;
  trackChild(child);
  child.once("error", (error) => {
    child.spawnError = error;
    children.delete(child);
  });

  return child;
}

async function waitForHttp(url, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const headers = options.headers ?? {};
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (options.service?.spawnError) throw options.service.spawnError;
    if (options.service
      && (options.service.exitCode !== null || options.service.signalCode !== null)) {
      throw new Error(`${options.service?.serviceName ?? "service"} exited before ${url} became ready`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(1_000);
  }

  throw lastError ?? new Error(`${url} did not become ready`);
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

async function stopService(child) {
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
  throw new Error(`failed to stop eval process tree ${child.pid ?? "unknown"}`);
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    let teardownComplete = false;
    try {
      if (lockAcquisitionPromise) await lockAcquisitionPromise.catch(() => {});
      const stopResults = await Promise.allSettled([...children].map(stopService));
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
        throw new AggregateError(teardownErrors, "eval teardown did not fully drain");
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

async function dumpComposeLogs() {
  try {
    console.error("[evals:local] command failed; dumping Compose logs before shutdown");
    await run("docker", ["compose", "logs", "--no-color"], { timeoutMs: 30_000 });
  } catch (error) {
    console.error("[evals:local] failed to dump Compose logs", error);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown()
      .catch((error) => console.error("[evals:local] shutdown failed", error))
      .finally(() => process.exit(130));
  });
}

try {
  lockAcquisitionPromise = acquireJanuslyComposeLock().then(async (release) => {
    if (shutdownPromise) {
      await release();
      throw new Error("eval shutdown began while acquiring the Compose lifecycle lock");
    }
    releaseComposeLock = release;
    return release;
  });
  await lockAcquisitionPromise;
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

  await waitForPostgres();
  await run("pnpm", ["migrate"]);

  // Only the API is needed: the golden runs hit `/ai/generate-workflow`, a
  // synchronous route that does no queue/worker work.
  const api = startService("api", "pnpm", ["--filter", "@janusly/api", "exec", "tsx", "src/index.ts"], {
    env: { PORT: "3001" },
  });

  await waitForHttp(`${apiUrl}/tools`, {
    headers: { "x-org-id": "default", "x-user-id": "dev-user" },
    service: api,
  });

  // Force the child harness to hit the API this wrapper owns, even if the
  // caller's shell points JANUSLY_EVALS_API_URL at another dev instance.
  // Forward extra CLI args (e.g. `--update-baseline`) to the harness.
  const forwardedArgs = process.argv.slice(2);
  await run("node", ["scripts/run-evals.mjs", ...forwardedArgs], {
    env: { JANUSLY_EVALS_API_URL: apiUrl },
  });
} catch (error) {
  if (composeStarted && !shutdownPromise) await dumpComposeLogs();
  throw error;
} finally {
  await shutdown();
}
