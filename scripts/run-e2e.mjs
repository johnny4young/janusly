/**
 * End-to-end test orchestrator.
 *
 * Runs the full Janusly stack against a clean Compose-managed Postgres + Redis
 * so Playwright can drive the real web UI through real API + worker processes.
 *
 * Lifecycle:
 *   1. acquire the host-global Janusly Compose lifecycle lock
 *   2. `docker compose up -d --renew-anon-volumes redis postgres`
 *   3. wait for Postgres to accept connections (`pg_isready`)
 *   4. `pnpm migrate` — applies the Drizzle migrations from packages/db
 *   5. spawn `apps/api` on a free local port (3001 when available) and
 *      `packages/engine` worker (detached process groups)
 *   6. wait for the API to answer `GET /tools` with the JSON tools catalog
 *      and dev headers (not just any HTTP 200 on the port)
 *   7. delegate to `pnpm --filter @janusly/web test:e2e` (Playwright)
 *   8. on failure: dump `docker compose logs` for the postmortem
 *   9. always: drain process groups + Compose, then release the lock
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
import { acquireJanuslyComposeLock, composeUpPullArgs } from "./process-lock.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_API_PORT = 3001;
const webBaseUrl = "http://127.0.0.1:5173";
const children = new Set();
let shutdownPromise = null;
let composeStarted = false;
let releaseHarnessLock = null;
let lockAcquisitionPromise = null;
const webTestArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processTreeIsAlive(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processTreeIsAlive(child) && Date.now() < deadline) {
    await sleep(25);
  }
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
      reject(new Error(`refusing to start ${command} during E2E shutdown`));
      return;
    }
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: rootDir,
      detached,
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
        if (!exited) {
          reject(new Error(`${command} ${args.join(" ")} left a live descendant process`));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(
            `${command} ${args.join(" ")} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
          ));
        }
      }, reject);
    });
    child.on("error", error => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) return;
      if (!processTreeIsAlive(child)) children.delete(child);
      reject(error);
    });
  });
}

function startService(name, command, args, options = {}) {
  if (shutdownPromise) {
    throw new Error(`refusing to start ${name} during E2E shutdown`);
  }
  const detached = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd: rootDir,
    detached,
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

async function allocateUniqueEphemeralPort(excludedPorts) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await allocateEphemeralPort();
    if (!excludedPorts.has(port)) {
      excludedPorts.add(port);
      return port;
    }
  }
  throw new Error("failed to allocate a collision-free service port");
}

async function resolveApiPort(preferredPort) {
  if (await isPortAvailable(preferredPort)) return preferredPort;

  const fallbackPort = await allocateEphemeralPort();
  console.error(`[e2e] API port ${preferredPort} is busy; using ${fallbackPort} for this run`);
  return fallbackPort;
}

function serviceExitReason(child) {
  if (!child) return null;
  if (child.spawnError) return `spawn error ${child.spawnError.message}`;
  if (child.exitCode !== null) return `code ${child.exitCode}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return null;
}

async function waitForServiceStability(service, stabilityMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < stabilityMs) {
    const exitReason = serviceExitReason(service);
    if (exitReason) throw new Error(`${service.serviceName ?? "service"} exited with ${exitReason} during startup`);
    await sleep(50);
  }
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
      await run("docker", [
        "compose", "exec", "-T", "postgres", "pg_isready",
        "-h", "127.0.0.1", "-U", "postgres", "-d", "workflow",
      ], { stdio: "ignore" });
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
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    // Re-check below; ESRCH is success, while an alive tree remains fenced.
  }
  if (await waitForProcessTreeExit(child, 5_000)) {
    children.delete(child);
    return;
  }

  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Re-check below before deciding whether teardown is complete.
  }
  if (await waitForProcessTreeExit(child, 2_000)) {
    children.delete(child);
    return;
  }
  throw new Error(`failed to stop E2E process tree ${child.pid ?? "unknown"}`);
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
        throw new AggregateError(teardownErrors, "E2E teardown did not fully drain");
      }
      teardownComplete = true;
    } finally {
      if (teardownComplete) {
        const release = releaseHarnessLock;
        releaseHarnessLock = null;
        if (release) await release();
      }
    }
  })();
  return shutdownPromise;
}

async function dumpComposeLogs() {
  try {
    console.error("[e2e] command failed; dumping Compose logs before shutdown");
    await run("docker", ["compose", "logs", "--no-color"], { timeoutMs: 30_000 });
  } catch (error) {
    console.error("[e2e] failed to dump Compose logs", error);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown()
      .catch((error) => console.error("[e2e] shutdown failed", error))
      .finally(() => process.exit(130));
  });
}

try {
  lockAcquisitionPromise = acquireJanuslyComposeLock().then(async (release) => {
    if (shutdownPromise) {
      await release();
      throw new Error("E2E shutdown began while acquiring the Compose lifecycle lock");
    }
    releaseHarnessLock = release;
    return release;
  });
  await lockAcquisitionPromise;
  const apiPort = await resolveApiPort(DEFAULT_API_PORT);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const allocatedServicePorts = new Set([apiPort, Number(new URL(webBaseUrl).port)]);
  const apiMetricsPort = await allocateUniqueEphemeralPort(allocatedServicePorts);
  const workerMetricsPort = await allocateUniqueEphemeralPort(allocatedServicePorts);
  const apiMetricsUrl = `http://127.0.0.1:${apiMetricsPort}/metrics`;
  const workerMetricsUrl = `http://127.0.0.1:${workerMetricsPort}/metrics`;

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

  // Integration lane (real-Postgres SQL-correctness tests) reuses this Compose
  // + migrate — no second lifecycle. Runs before API boot; its tests use unique
  // org ids so they never collide with the Playwright `default` org.
  await run("pnpm", ["--filter", "@janusly/data", "test:integration"]);
  await run("pnpm", ["--filter", "@janusly/api", "test:integration"]);
  await run("pnpm", ["--filter", "@janusly/engine", "test:integration"]);

  // Load root env first, then force the memory platform gate on only inside
  // this disposable E2E stack. Tenant consent still defaults off, so existing
  // scenarios remain unchanged while governance tests can exercise both gates.
  const e2eApiBootstrap = [
    'import("@janusly/db").then(() => {',
    'process.env.JANUSLY_MEMORY_ENABLED = "true";',
    `process.env.OTEL_METRICS_PORT = "${apiMetricsPort}";`,
    'return import("./src/index.ts");',
    "});",
  ].join("");
  const api = startService("api", "pnpm", [
    "--filter", "@janusly/api", "exec", "tsx", "--eval", e2eApiBootstrap,
  ], {
    env: {
      PORT: String(apiPort),
      OTEL_METRICS_PORT: String(apiMetricsPort),
    },
  });
  // `@janusly/db` intentionally lets the root `.env` override inherited
  // process variables. Load it first, then enable private targets only in this
  // disposable E2E worker so the Playwright-owned loopback target can hold a
  // real HTTP node in `running`; production and normal development retain the
  // secure default.
  const e2eWorkerBootstrap = [
    'import("@janusly/db").then(() => {',
    'process.env.ALLOW_PRIVATE_HTTP_TARGETS = "true";',
    'process.env.JANUSLY_MEMORY_ENABLED = "true";',
    `process.env.OTEL_METRICS_PORT = "${workerMetricsPort}";`,
    'return import("./src/worker.ts");',
    "});",
  ].join("");
  const worker = startService("worker", "pnpm", [
    "--filter",
    "@janusly/engine",
    "exec",
    "tsx",
    "--eval",
    e2eWorkerBootstrap,
  ], {
    env: {
      OTEL_METRICS_PORT: String(workerMetricsPort),
    },
  });

  await waitForHttp(`${apiUrl}/tools`, {
    headers: { "x-org-id": "default", "x-user-id": "dev-user" },
    service: api,
    validate: validateToolsCatalog,
  });
  // The worker has no HTTP health endpoint. Keep its process handle and require
  // it to survive the API startup window plus a short stabilization period so
  // bootstrap/import failures fail here instead of surfacing as Playwright timeouts.
  await waitForServiceStability(worker);
  await waitForHttp(apiMetricsUrl, { service: api });
  await waitForHttp(workerMetricsUrl, { service: worker });

  await run("pnpm", [
    "--filter",
    "@janusly/web",
    "test:e2e",
    ...webTestArgs,
  ], {
    env: {
      PLAYWRIGHT_BASE_URL: webBaseUrl,
      E2E_API_URL: apiUrl,
      E2E_API_METRICS_URL: apiMetricsUrl,
      E2E_WORKER_METRICS_URL: workerMetricsUrl,
      VITE_API_URL: apiUrl,
    },
  });
} catch (error) {
  if (composeStarted && !shutdownPromise) await dumpComposeLogs();
  throw error;
} finally {
  await shutdown();
}
