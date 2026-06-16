/**
 * One-command LOCAL golden-eval regression gate.
 *
 * Boots the minimum stack needed to run the AI workflow-generation golden
 * runs against a real API, runs them, and tears everything down — so a
 * developer can check `evals/generate-workflow.jsonl` for regressions with a
 * single command instead of remembering to start `pnpm dev` first.
 *
 * Lifecycle:
 *   1. `docker compose up -d --renew-anon-volumes redis postgres`
 *   2. wait for Postgres to accept connections (`pg_isready`)
 *   3. `pnpm migrate` — applies the Drizzle migrations from packages/db
 *   4. spawn `apps/api` only (detached process group) on PORT 3001
 *   5. wait for the API to answer `GET /tools` with dev headers
 *   6. run `scripts/run-evals.mjs` against it (non-zero exit on regression)
 *   7. on failure: dump `docker compose logs` for the postmortem
 *   8. always: shut down the API + `docker compose down`
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

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const apiUrl = "http://127.0.0.1:3001";
const children = new Set();
let shuttingDown = false;

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
    console.error("[evals:local] command failed; dumping Compose logs before shutdown");
    await run("docker", ["compose", "logs", "--no-color"]);
  } catch (error) {
    console.error("[evals:local] failed to dump Compose logs", error);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await shutdown();
    process.exit(130);
  });
}

try {
  await run("docker", ["compose", "up", "-d", "--renew-anon-volumes", "redis", "postgres"]);

  await waitForPostgres();
  await run("pnpm", ["migrate"]);

  // Only the API is needed: the golden runs hit `/ai/generate-workflow`, a
  // synchronous route that does no queue/worker work.
  startService("api", "pnpm", ["--filter", "@janusly/api", "exec", "tsx", "src/index.ts"], {
    env: { PORT: "3001" },
  });

  await waitForHttp(`${apiUrl}/tools`, {
    headers: { "x-org-id": "default", "x-user-id": "dev-user" },
  });

  // Force the child harness to hit the API this wrapper owns, even if the
  // caller's shell points JANUSLY_EVALS_API_URL at another dev instance.
  // Forward extra CLI args (e.g. `--update-baseline`) to the harness.
  const forwardedArgs = process.argv.slice(2);
  await run("node", ["scripts/run-evals.mjs", ...forwardedArgs], {
    env: { JANUSLY_EVALS_API_URL: apiUrl },
  });
} catch (error) {
  await dumpComposeLogs();
  throw error;
} finally {
  await shutdown();
}
