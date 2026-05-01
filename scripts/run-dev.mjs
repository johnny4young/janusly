/**
 * One-command dev orchestrator.
 *
 * `pnpm dev` at the workspace root runs this. It brings up the full local
 * stack so a fresh checkout is `pnpm install && pnpm dev` to a working
 * Janusly Studio at http://localhost:5173.
 *
 * Lifecycle:
 *   1. `docker compose up -d redis postgres`
 *   2. wait for Postgres readiness via `pg_isready`
 *   3. `pnpm migrate` — applies Drizzle migrations idempotently
 *   4. spawn api / worker / web binaries directly (`tsx watch ...` and
 *      `vite`) in detached process groups, with each child's `cwd` set to
 *      its workspace and `PATH` augmented to find the workspace's local
 *      `node_modules/.bin`. Skipping the `pnpm <script>` wrapper keeps
 *      Ctrl+C teardown quiet — the wrapper would otherwise emit
 *      `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` for every child it SIGTERMs.
 *   5. wait forever; `Ctrl+C` (or any child exiting unexpectedly) triggers `shutdown`
 *   6. `shutdown` SIGTERMs each child, then `docker compose down` so no
 *      containers leak across sessions
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
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter as pathDelimiter } from "node:path";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const children = new Set();
let shuttingDown = false;

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

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function startService(name, command, args, options = {}) {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd: options.cwd ?? rootDir,
    detached,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });

  child.serviceName = name;
  children.add(child);

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      // A dev service exited unexpectedly (syntax error, port in use, manual
      // kill, or a clean early exit) — tearing the whole stack down so the
      // developer notices instead of running partially-degraded silently.
      const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      console.error(`[dev] ${name} exited with ${reason}; tearing the stack down`);
      void shutdown().then(() => process.exit(code && code !== 0 ? code : 1));
    }
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
  return [
    `${rootDir}/${workspaceDir}/node_modules/.bin`,
    `${rootDir}/node_modules/.bin`,
    process.env.PATH,
  ]
    .filter(Boolean)
    .join(pathDelimiter);
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

async function stopService(child) {
  if (!child || child.exitCode !== null || child.killed) return;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
      resolve();
    }, 5_000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.error("[dev] shutting down");
  await Promise.all([...children].map(stopService));
  try {
    await run("docker", ["compose", "down"]);
  } catch (error) {
    console.error("[dev] docker compose down failed", error);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown();
    // Ctrl+C is a clean user-driven shutdown — return 0 so the wrapping
    // `pnpm dev` exits cleanly too. Without this the outer pnpm prints
    // `ELIFECYCLE Command failed with exit code 130` which makes a normal
    // teardown look like a failure.
    process.exit(0);
  });
}

try {
  await run("docker", ["compose", "up", "-d", "redis", "postgres"]);
  await waitForPostgres();
  await run("pnpm", ["migrate"]);

  // Mirror each workspace's `dev` script (tsx watch / vite) directly so we
  // don't invoke `pnpm <script>` per child — that wrapper noisily wraps the
  // orchestrator's own SIGTERM as a script failure on Ctrl+C. If a workspace
  // changes its dev command, update the line here too.
  startService("api", "tsx", ["watch", "src/index.ts"], {
    cwd: `${rootDir}/apps/api`,
    env: { PATH: workspaceBinPath("apps/api") },
  });
  startService("worker", "tsx", ["watch", "src/worker.ts"], {
    cwd: `${rootDir}/packages/engine`,
    env: { PATH: workspaceBinPath("packages/engine") },
  });
  startService("web", "vite", [], {
    cwd: `${rootDir}/apps/web`,
    env: { PATH: workspaceBinPath("apps/web") },
  });

  console.error("[dev] api / worker / web spawned; press Ctrl+C to tear down");
  // Stay alive until a signal handler exits the process or a child crashes.
  await new Promise(() => {});
} catch (error) {
  console.error(error);
  await shutdown();
  process.exit(1);
}
