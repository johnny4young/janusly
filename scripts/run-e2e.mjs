/**
 * End-to-end test orchestrator.
 *
 * Runs the full Janusly stack against a clean Compose-managed Postgres + Redis
 * so Playwright can drive the real web UI through real API + worker processes.
 *
 * Lifecycle:
 *   1. `docker compose up -d redis postgres`
 *   2. wait for Postgres to accept connections (`pg_isready`)
 *   3. `pnpm migrate` — applies the Drizzle migrations from packages/db
 *   4. spawn `apps/api` and `packages/engine` worker (detached process groups)
 *   5. wait for the API to answer `GET /tools` with dev headers
 *   6. delegate to `pnpm --filter @janusly/web test:e2e` (Playwright)
 *   7. on failure: dump `docker compose logs` for the postmortem
 *   8. always: shut down child services + `docker compose down`
 *
 * Used by:
 * - root `package.json` `test:e2e` script
 * - `.github/workflows/ci.yml` `test_e2e` job
 *
 * Invariants:
 * - The harness owns the full Compose lifecycle. Don't move Compose
 *   orchestration into the workflow YAML — local and CI must use the same
 *   path so behaviour stays identical.
 * - SIGINT/SIGTERM handlers are installed; Ctrl+C in dev tears everything
 *   down rather than orphaning containers.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const children = new Set();
let shuttingDown = false;
const webTestArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
    });

    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function startService(name, command, args, options = {}) {
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd: rootDir,
    detached,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });

  child.serviceName = name;
  children.add(child);

  child.on("exit", () => {
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
      await new Promise((resolve, reject) => {
        const child = spawn("docker", ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "postgres"], {
          cwd: rootDir,
          stdio: "ignore",
        });
        child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`pg_isready exited ${code}`))));
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

  await new Promise(resolve => {
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

  await Promise.all([...children].map(stopService));
  await run("docker", ["compose", "down"]);
}

async function dumpComposeLogs() {
  try {
    console.error("[e2e] command failed; dumping Compose logs before shutdown");
    await run("docker", ["compose", "logs", "--no-color"]);
  } catch (error) {
    console.error("[e2e] failed to dump Compose logs", error);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown();
    process.exit(130);
  });
}

try {
  await run("docker", ["compose", "up", "-d", "redis", "postgres"]);

  await waitForPostgres();
  await run("pnpm", ["migrate"]);

  startService("api", "pnpm", ["--filter", "@janusly/api", "exec", "tsx", "src/index.ts"], {
    env: { PORT: "3001" },
  });
  startService("worker", "pnpm", ["--filter", "@janusly/engine", "exec", "tsx", "src/worker.ts"]);

  await waitForHttp("http://127.0.0.1:3001/tools", {
    headers: { "x-org-id": "default", "x-user-id": "dev-user" },
  });

  await run("pnpm", [
    "--filter",
    "@janusly/web",
    "test:e2e",
    ...(webTestArgs.length ? ["--", ...webTestArgs] : []),
  ], {
    env: {
      PLAYWRIGHT_BASE_URL: "http://127.0.0.1:5173",
      VITE_API_URL: "http://127.0.0.1:3001",
    },
  });
} catch (error) {
  await dumpComposeLogs();
  throw error;
} finally {
  await shutdown();
}
