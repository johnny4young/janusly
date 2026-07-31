// Boots an ISOLATED reference stack (the pinned Node backend) and runs a
// command against it — the golden-capture workhorse:
//
//   node go/conformance/run-reference-stack.mjs node go/conformance/gen-goldens.mjs
//   GOLDENS_ONLY=F11 node go/conformance/run-reference-stack.mjs node go/conformance/gen-goldens.mjs
//
// Own Compose project (janusly-goldens) + own host ports (PG 4732, Redis
// 4733, API 3101, metrics 9564/9565), so a capture never contends with the
// repo's fixed-port lifecycle lock (run-dev / run-e2e), never pollutes a
// live dev database, and never touches the pilot's own Postgres. The child
// command receives GOLDENS_API_URL pointing at the booted API. Everything
// is torn down (including the throwaway database) on exit.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const COMPOSE = ["compose", "-f", join(HERE, "reference-stack.compose.yml")];
const API_PORT = "3101";
const DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:4732/workflow";
const REDIS_URL = "redis://127.0.0.1:4733";

const children = [];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} exited ${code}`))));
    child.on("error", reject);
  });
}

function startService(name, cwd, entry, extraEnv) {
  // tsx lives in each workspace's own node_modules/.bin under pnpm.
  const child = spawn(join(cwd, "node_modules", ".bin", "tsx"), [entry], {
    cwd,
    detached: true, // own process group so teardown reaps tsx's children too
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, DATABASE_URL, REDIS_URL, ...extraEnv },
  });
  child.on("error", (error) => console.error(`[goldens stack] ${name}:`, error.message));
  children.push({ name, child });
  return child;
}

async function teardown() {
  for (const { child } of children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  }
  await delay(500);
  for (const { child } of children) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  }
  await run("docker", [...COMPOSE, "down", "-v"]).catch(() => {});
}

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: node run-reference-stack.mjs <command...>");
  process.exit(2);
}

let exitCode = 1;
try {
  console.error("== goldens stack: compose up (project janusly-goldens) ==");
  await run("docker", [...COMPOSE, "up", "-d", "--wait"]);

  console.error("== goldens stack: migrate ==");
  await run("pnpm", ["migrate"], { cwd: REPO, env: { ...process.env, DATABASE_URL } });

  console.error("== goldens stack: api + worker ==");
  startService("api", join(REPO, "apps", "api"), "src/index.ts", {
    PORT: API_PORT, OTEL_METRICS_PORT: "9564",
  });
  startService("worker", join(REPO, "packages", "engine"), "src/worker.ts", {
    OTEL_METRICS_PORT: "9565",
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/health`);
      if (res.ok) break;
    } catch { /* booting */ }
    if (Date.now() > deadline) throw new Error("reference api never became healthy");
    await delay(300);
  }

  console.error("== goldens stack: running", command.join(" "), "==");
  await run(command[0], command.slice(1), {
    cwd: REPO,
    env: { ...process.env, GOLDENS_API_URL: `http://127.0.0.1:${API_PORT}` },
  });
  exitCode = 0;
} catch (error) {
  console.error("[goldens stack]", error.message ?? error);
} finally {
  await teardown();
}
process.exit(exitCode);
