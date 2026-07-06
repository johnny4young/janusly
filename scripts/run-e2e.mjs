/**
 * End-to-end test orchestrator.
 *
 * Runs the full Janusly stack against a clean Compose-managed Postgres + Redis
 * so Playwright can drive the real web UI through real API + worker processes.
 *
 * Lifecycle:
 *   1. `docker compose up -d --renew-anon-volumes redis postgres`
 *   2. wait for Postgres to accept connections (`pg_isready`)
 *   3. `pnpm migrate` — applies the Drizzle migrations from packages/db
 *   4. spawn `apps/api` on a free local port (3001 when available) and
 *      `packages/engine` worker (detached process groups)
 *   5. wait for the API to answer `GET /tools` with the JSON tools catalog
 *      and dev headers (not just any HTTP 200 on the port)
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
 * - Postgres / Redis data must be clean for every run. These images use
 *   anonymous container volumes for data, so `docker compose down` alone is
 *   not enough: the next `up` may reattach stale state. Always start infra
 *   with `--renew-anon-volumes`; do not use `down -v`, because that also
 *   deletes the named Ollama model cache used by `pnpm dev`.
 * - SIGINT/SIGTERM handlers are installed; Ctrl+C in dev tears everything
 *   down rather than orphaning containers.
 */

import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_API_PORT = 3001;
const webBaseUrl = "http://127.0.0.1:5173";
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

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("failed to allocate an API port"));
      });
    });
  });
}

async function resolveApiPort(preferredPort) {
  if (await isPortAvailable(preferredPort)) return preferredPort;

  const fallbackPort = await allocateEphemeralPort();
  console.error(`[e2e] API port ${preferredPort} is busy; using ${fallbackPort} for this run`);
  return fallbackPort;
}

function serviceExitReason(child) {
  if (!child) return null;
  if (child.exitCode !== null) return `code ${child.exitCode}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return null;
}

async function validateToolsCatalog(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return `returned ${contentType || "no Content-Type"} instead of the JSON tools catalog`;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return "returned invalid JSON instead of the tools catalog";
  }

  if (!Array.isArray(payload)) return "did not return the tools catalog array";
  if (!payload.every((tool) => tool && typeof tool === "object" && typeof tool.name === "string")) {
    return "returned a malformed tools catalog";
  }

  return true;
}

async function waitForHttp(url, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const headers = options.headers ?? {};
  const validate = options.validate ?? (async () => true);
  const service = options.service;
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    const exitReason = serviceExitReason(service);
    if (exitReason) {
      throw new Error(`${service.serviceName ?? "service"} exited with ${exitReason} before ${url} became ready`);
    }

    try {
      const response = await fetch(url, { headers });
      if (response.ok) {
        const validation = await validate(response);
        if (validation === true) return;
        lastError = new Error(`${url} ${validation}`);
      } else {
        lastError = new Error(`${url} returned ${response.status}`);
      }
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
  const apiPort = await resolveApiPort(DEFAULT_API_PORT);
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  await run("docker", ["compose", "up", "-d", "--renew-anon-volumes", "redis", "postgres"]);

  await waitForPostgres();
  await run("pnpm", ["migrate"]);

  // Integration lane (real-Postgres SQL-correctness tests) reuses this Compose
  // + migrate — no second lifecycle. Runs before API boot; its tests use unique
  // org ids so they never collide with the Playwright `default` org.
  await run("pnpm", ["--filter", "@janusly/data", "test:integration"]);

  const api = startService("api", "pnpm", ["--filter", "@janusly/api", "exec", "tsx", "src/index.ts"], {
    env: { PORT: String(apiPort) },
  });
  startService("worker", "pnpm", ["--filter", "@janusly/engine", "exec", "tsx", "src/worker.ts"]);

  await waitForHttp(`${apiUrl}/tools`, {
    headers: { "x-org-id": "default", "x-user-id": "dev-user" },
    service: api,
    validate: validateToolsCatalog,
  });

  await run("pnpm", [
    "--filter",
    "@janusly/web",
    "test:e2e",
    ...webTestArgs,
  ], {
    env: {
      PLAYWRIGHT_BASE_URL: webBaseUrl,
      E2E_API_URL: apiUrl,
      VITE_API_URL: apiUrl,
    },
  });
} catch (error) {
  await dumpComposeLogs();
  throw error;
} finally {
  await shutdown();
}
