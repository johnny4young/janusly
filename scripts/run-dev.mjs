/**
 * One-command dev orchestrator.
 *
 * `pnpm dev` at the workspace root runs this. It brings up the full local
 * stack so a fresh checkout is `pnpm install && pnpm dev` to a working
 * Janusly Studio at http://127.0.0.1:5173.
 *
 * Lifecycle:
 *   1. acquire the host-global Janusly Compose lifecycle lock
 *   2. `docker compose up -d redis postgres ollama`
 *   3. wait for Postgres readiness via `pg_isready`
 *   4. `pnpm migrate` — applies Drizzle migrations idempotently
 *   5. spawn api / worker / web binaries directly (`tsx watch ...` and
 *      `vite`) in detached process groups, with each child's `cwd` set to
 *      its workspace and `PATH` augmented to find the workspace's local
 *      `node_modules/.bin`. Skipping the `pnpm <script>` wrapper keeps
 *      Ctrl+C teardown quiet — the wrapper would otherwise emit
 *      `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` for every child it SIGTERMs.
 *   6. wait for API + web HTTP readiness, then print the browser URL
 *   7. wait forever; `Ctrl+C` (or any child exiting unexpectedly) triggers `shutdown`
 *   8. drain process groups + Compose, then release the lifecycle lock
 *
 * Used by:
 * - root `package.json` `dev` script
 *
 * Invariants:
 * - Mirrors `scripts/run-e2e.mjs` so local + CI behaviour share the same
 *   Compose-lifecycle helpers. Don't drift this away from that one.
 * - Always runs `docker compose down` on exit (AGENTS.md Compose lifecycle).
 * - Runs `pnpm migrate` between Compose-up and api/worker boot — preserves
 *   the invariant that api/worker call `assertMigrationsApplied()`
 *   and refuse to boot otherwise.
 * - Sets a host-reachable `OLLAMA_BASE_URL` for api/worker children when the
 *   caller did not provide one. The embedding code's library default is
 *   `http://ollama:11434` for containerized deployments, but `pnpm dev` runs
 *   Node on the host and reaches the Compose service through port 11434.
 * - Vite binds loopback by default on strict port 5173. Deliberate LAN or
 *   container exposure requires an explicit validated `JANUSLY_DEV_HOST`.
 * - The private `JANUSLY_DEV_BIN_PATH` seam is used by the subprocess test
 *   harness to replace long-running binaries without touching node_modules.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter as pathDelimiter } from "node:path";
import { acquireJanuslyComposeLock, composeUpPullArgs } from "./process-lock.mjs";
import { devWebUrl, resolveDevHost, viteArgs } from "./run-dev-config.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const children = new Set();
let shutdownPromise = null;
let composeStarted = false;
let releaseComposeLock = null;
let lockAcquisitionPromise = null;
const hostOllamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const devHost = resolveDevHost(process.env.JANUSLY_DEV_HOST);
const webUrl = devWebUrl(devHost);
const parsedComposeDownTimeoutMs = Number(process.env.JANUSLY_DEV_COMPOSE_DOWN_TIMEOUT_MS);
const composeDownTimeoutMs = Number.isFinite(parsedComposeDownTimeoutMs)
  && parsedComposeDownTimeoutMs >= 100
  ? parsedComposeDownTimeoutMs
  : 30_000;

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
      reject(new Error(`refusing to start ${command} during dev shutdown`));
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
  if (shutdownPromise) throw new Error(`refusing to start ${name} during dev shutdown`);
  const child = spawn(command, args, {
    cwd: options.cwd ?? rootDir,
    detached: true,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });

  child.serviceName = name;
  trackChild(child);

  child.once("error", (error) => {
    child.spawnError = error;
    children.delete(child);
    if (shutdownPromise) return;
    console.error(`[dev] failed to start ${name}`, error);
    void shutdown()
      .catch((shutdownError) => console.error("[dev] shutdown failed", shutdownError))
      .finally(() => process.exit(1));
  });

  child.on("exit", (code, signal) => {
    void waitForProcessTreeExit(child, 1_000).then(() => {
      if (shutdownPromise) return;
      // A dev service exited unexpectedly (syntax error, port in use, manual
      // kill, or a clean early exit) — tearing the whole stack down so the
      // developer notices instead of running partially-degraded silently.
      const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      console.error(`[dev] ${name} exited with ${reason}; tearing the stack down`);
      void shutdown()
        .catch((error) => console.error("[dev] shutdown failed", error))
        .finally(() => process.exit(code && code !== 0 ? code : 1));
    });
  });

  return child;
}

// PATH augmentation so the orchestrator's child spawns find the workspace's
// own `.bin` first (where tsx, vite, etc. live for that workspace), then the
// repo-root `.bin`, then the user's shell `PATH`. Skipping the pnpm wrapper
// keeps Ctrl+C teardown quiet — `pnpm <script>` would otherwise emit
// `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` + `Exit status 143` for every child as
// it rewraps the SIGTERM the orchestrator just sent it.
function workspaceBinPath(workspaceDir) {
  if (process.env.JANUSLY_DEV_BIN_PATH) {
    return [process.env.JANUSLY_DEV_BIN_PATH, process.env.PATH]
      .filter(Boolean)
      .join(pathDelimiter);
  }
  return [
    `${rootDir}/${workspaceDir}/node_modules/.bin`,
    `${rootDir}/node_modules/.bin`,
    process.env.PATH,
  ]
    .filter(Boolean)
    .join(pathDelimiter);
}

async function waitForHttp(url, child, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (child.spawnError) throw child.spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${child.serviceName} exited before ${url} became ready`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
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
  throw new Error(`failed to stop dev process tree ${child.pid ?? "unknown"}`);
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    let teardownComplete = false;
    try {
      console.error("[dev] shutting down");
      if (lockAcquisitionPromise) await lockAcquisitionPromise.catch(() => {});
      const stopResults = await Promise.allSettled([...children].map(stopService));
      const teardownErrors = stopResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (composeStarted) {
        try {
          await run("docker", ["compose", "down"], {
            allowDuringShutdown: true,
            timeoutMs: composeDownTimeoutMs,
          });
          composeStarted = false;
        } catch (error) {
          teardownErrors.push(error);
        }
      }
      if (teardownErrors.length > 0) {
        throw new AggregateError(teardownErrors, "dev teardown did not fully drain");
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
      // Ctrl+C is a clean user-driven shutdown — return 0 so the wrapping
      // `pnpm dev` exits cleanly too. Without this the outer pnpm prints
      // `ELIFECYCLE Command failed with exit code 130` which makes a normal
      // teardown look like a failure.
      .then(
        () => process.exit(0),
        (error) => {
          console.error("[dev] shutdown failed", error);
          process.exit(1);
        },
      );
  });
}

try {
  lockAcquisitionPromise = acquireJanuslyComposeLock().then(async (release) => {
    if (shutdownPromise) {
      await release();
      throw new Error("dev shutdown began while acquiring the Compose lifecycle lock");
    }
    releaseComposeLock = release;
    return release;
  });
  await lockAcquisitionPromise;
  composeStarted = true;
  await run(
    "docker",
    ["compose", "up", ...composeUpPullArgs(), "-d", "redis", "postgres", "ollama"],
    { timeoutMs: 5 * 60_000 },
  );
  await waitForPostgres();
  await run("pnpm", ["migrate"]);

  // Mirror each workspace's `dev` script (tsx watch / vite) directly so we
  // don't invoke `pnpm <script>` per child — that wrapper noisily wraps the
  // orchestrator's own SIGTERM as a script failure on Ctrl+C. If a workspace
  // changes its dev command, update the line here too.
  const api = startService("api", "tsx", ["watch", "src/index.ts"], {
    cwd: `${rootDir}/apps/api`,
    env: { PATH: workspaceBinPath("apps/api"), OLLAMA_BASE_URL: hostOllamaBaseUrl },
  });
  startService("worker", "tsx", ["watch", "src/worker.ts"], {
    cwd: `${rootDir}/packages/engine`,
    env: { PATH: workspaceBinPath("packages/engine"), OLLAMA_BASE_URL: hostOllamaBaseUrl },
  });
  const web = startService("web", "vite", viteArgs(devHost), {
    cwd: `${rootDir}/apps/web`,
    env: { PATH: workspaceBinPath("apps/web") },
  });

  await Promise.all([
    waitForHttp(`http://127.0.0.1:${process.env.PORT || "3001"}/health`, api),
    waitForHttp(webUrl, web),
  ]);
  console.error(`[dev] ready at ${webUrl} (bound ${devHost}); press Ctrl+C to tear down`);
  // Stay alive until a signal handler exits the process or a child crashes.
  await new Promise(() => {});
} catch (error) {
  console.error(error);
  await shutdown();
  process.exit(1);
}
