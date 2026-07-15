/** Unit and subprocess lifecycle coverage for the root development orchestrator. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_DEV_HOST, devWebUrl, resolveDevHost, viteArgs } from "./run-dev-config.mjs";
import {
  acquireJanuslyComposeLock,
  JANUSLY_COMPOSE_LOCK_PATH,
} from "./process-lock.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
let lifecycleTestTail = Promise.resolve();

function serialTest(name, options, handler) {
  test(name, options, async (t) => {
    const previous = lifecycleTestTail;
    let release;
    lifecycleTestTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      await handler(t);
    } finally {
      release();
    }
  });
}

test("development host defaults to loopback and rejects URL/path input", () => {
  assert.equal(resolveDevHost(undefined), DEFAULT_DEV_HOST);
  assert.equal(resolveDevHost("localhost"), "localhost");
  assert.equal(resolveDevHost("0.0.0.0"), "0.0.0.0");
  assert.equal(resolveDevHost("devbox.local"), "devbox.local");
  assert.throws(() => resolveDevHost(" http://localhost"), /hostname or IP address/);
  assert.throws(() => resolveDevHost("http://localhost"), /hostname or IP address/);
  assert.throws(() => resolveDevHost("localhost/path"), /hostname or IP address/);
  assert.throws(() => resolveDevHost("bad host"), /hostname or IP address/);
});

test("development URL and Vite arguments preserve strict deterministic port semantics", () => {
  assert.equal(devWebUrl("127.0.0.1"), "http://127.0.0.1:5173");
  assert.equal(devWebUrl("::1"), "http://[::1]:5173");
  assert.equal(devWebUrl("0.0.0.0"), "http://localhost:5173");
  assert.deepEqual(viteArgs("127.0.0.1"), ["--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
});

serialTest("development orchestrator waits for readiness and awaited Compose teardown", { timeout: 30_000 }, async (t) => {
  if (!(await portsAreFree([3001, 5173]))) {
    t.skip("development ports 3001/5173 are already in use");
    return;
  }

  const sandbox = await mkdtemp(join(tmpdir(), "janusly-run-dev-"));
  const logPath = join(sandbox, "lifecycle.log");
  let child;
  let ownedLock;
  try {
    await Promise.all([
      writeExecutable(sandbox, "docker", fakeDockerSource),
      writeExecutable(sandbox, "pnpm", fakePnpmSource),
      writeExecutable(sandbox, "tsx", fakeTsxSource),
      writeExecutable(sandbox, "vite", fakeViteSource),
    ]);

    child = spawn(process.execPath, ["scripts/run-dev.mjs"], {
      cwd: rootDir,
      detached: true,
      env: {
        ...process.env,
        COMPOSE_PULL_POLICY: "",
        PATH: `${sandbox}:${process.env.PATH ?? ""}`,
        JANUSLY_DEV_BIN_PATH: sandbox,
        JANUSLY_DEV_HOST: "127.0.0.1",
        JANUSLY_DEV_TEST_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });

    await waitUntil(() => output.includes("[dev] ready at http://127.0.0.1:5173"), 12_000, () => output);
    ownedLock = await waitForLockOwner(child.pid);
    const response = await fetch("http://127.0.0.1:5173");
    assert.equal(response.status, 200);

    const exited = waitForExit(child);
    child.kill("SIGINT");
    child.kill("SIGTERM");
    const { code, signal } = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0, output);

    const lifecycle = await readFile(logPath, "utf8");
    assert.match(lifecycle, /docker compose up -d redis postgres ollama/);
    assert.match(lifecycle, /pnpm migrate/);
    assert.match(lifecycle, /api ready/);
    assert.match(lifecycle, /web ready --host 127\.0\.0\.1 --port 5173 --strictPort/);
    assert.ok(lifecycle.indexOf("compose down start") < lifecycle.indexOf("compose down done"));
    assert.equal(lifecycle.match(/^docker compose down$/gm)?.length, 1);
    assert.ok(output.indexOf("[dev] shutting down") < output.length);
    await assert.rejects(fetch("http://127.0.0.1:5173"));
  } finally {
    await terminateProcessGroup(child);
    await terminateLoggedServiceGroups(logPath);
    await removeOwnedLock(ownedLock);
    await rm(sandbox, { recursive: true, force: true });
  }
});

serialTest("shared Compose lock rejects every competing orchestrator without teardown", { timeout: 20_000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-compose-conflict-"));
  const logPath = join(sandbox, "docker.log");
  const release = await acquireJanuslyComposeLock();
  try {
    await writeExecutable(sandbox, "docker", fakeDockerSource);
    const env = {
      ...process.env,
      COMPOSE_PULL_POLICY: "",
      PATH: `${sandbox}:${dirname(process.execPath)}:/usr/bin:/bin`,
      JANUSLY_DEV_TEST_LOG: logPath,
    };
    const invocations = [
      ["scripts/run-dev.mjs"],
      ["scripts/run-integration.mjs"],
      ["scripts/run-evals-local.mjs"],
      ["scripts/run-e2e.mjs", "--", "queue-pressure-observability.spec.ts"],
    ];
    for (const args of invocations) {
      const result = await spawnForResult(args, env);
      assert.equal(result.code, 1, `${args[0]}\n${result.output}`);
      assert.match(result.output, new RegExp(`already running under pid ${process.pid}`));
    }
    assert.equal(await readOptional(logPath), "");
  } finally {
    await release();
    await rm(sandbox, { recursive: true, force: true });
  }
});

serialTest("development spawn failure tears Compose down and releases its lock", { timeout: 30_000 }, async (t) => {
  if (!(await portsAreFree([3001, 5173]))) {
    t.skip("development ports 3001/5173 are already in use");
    return;
  }
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-run-dev-spawn-error-"));
  const logPath = join(sandbox, "lifecycle.log");
  let result;
  let ownedLock;
  try {
    await Promise.all([
      writeExecutable(sandbox, "docker", fakeDockerSource),
      writeExecutable(sandbox, "pnpm", fakePnpmSource),
      writeExecutable(sandbox, "vite", fakeViteSource),
    ]);
    result = await spawnForResult(["scripts/run-dev.mjs"], {
      ...process.env,
      COMPOSE_PULL_POLICY: "",
      PATH: `${sandbox}:${dirname(process.execPath)}:/usr/bin:/bin`,
      JANUSLY_DEV_BIN_PATH: sandbox,
      JANUSLY_DEV_HOST: "127.0.0.1",
      JANUSLY_DEV_TEST_LOG: logPath,
    }, {
      captureLockOwner: true,
      onLockOwner: (owner) => { ownedLock = owner; },
    });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /failed to start (api|worker)/);
    assert.match(await readFile(logPath, "utf8"), /compose down done/);
    await assert.rejects(readFile(JANUSLY_COMPOSE_LOCK_PATH, "utf8"), /ENOENT/);
  } finally {
    await terminateLoggedServiceGroups(logPath);
    await removeOwnedLock(ownedLock);
    await rm(sandbox, { recursive: true, force: true });
  }
});

serialTest("failed Compose teardown exits nonzero and preserves the manual-recovery lock", { timeout: 30_000 }, async (t) => {
  if (!(await portsAreFree([3001, 5173]))) {
    t.skip("development ports 3001/5173 are already in use");
    return;
  }
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-run-dev-down-failure-"));
  const logPath = join(sandbox, "lifecycle.log");
  let child;
  let ownedLock;
  try {
    await Promise.all([
      writeExecutable(sandbox, "docker", fakeDockerSource),
      writeExecutable(sandbox, "pnpm", fakePnpmSource),
      writeExecutable(sandbox, "tsx", fakeTsxSource),
      writeExecutable(sandbox, "vite", fakeViteSource),
    ]);
    child = spawn(process.execPath, ["scripts/run-dev.mjs"], {
      cwd: rootDir,
      detached: true,
      env: {
        ...process.env,
        COMPOSE_PULL_POLICY: "",
        PATH: `${sandbox}:${process.env.PATH ?? ""}`,
        JANUSLY_DEV_BIN_PATH: sandbox,
        JANUSLY_DEV_HOST: "127.0.0.1",
        JANUSLY_DEV_TEST_LOG: logPath,
        JANUSLY_DEV_HANG_DOWN: "1",
        JANUSLY_DEV_COMPOSE_DOWN_TIMEOUT_MS: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    await waitUntil(() => output.includes("[dev] ready at http://127.0.0.1:5173"), 12_000, () => output);
    ownedLock = await readLockOwner();
    assert.equal(ownedLock?.pid, child.pid);
    const exited = waitForExit(child);
    child.kill("SIGINT");
    const result = await exited;
    assert.equal(result.code, 1, output);
    assert.match(output, /shutdown failed/);
    assert.match(await readFile(JANUSLY_COMPOSE_LOCK_PATH, "utf8"), new RegExp(`"pid":${child.pid}`));
  } finally {
    await terminateProcessGroup(child);
    await terminateLoggedServiceGroups(logPath);
    await removeOwnedLock(ownedLock);
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function writeExecutable(directory, name, source) {
  const path = join(directory, name);
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function portsAreFree(ports) {
  const results = await Promise.all(ports.map((port) => new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  })));
  return results.every(Boolean);
}

async function waitUntil(predicate, timeoutMs, details) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for condition\n${details()}`);
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child ${child.pid ?? "unknown"} to exit`));
    }, timeoutMs);
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function spawnForResult(args, env, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    if (options.captureLockOwner) {
      const owner = await waitForLockOwner(child.pid);
      options.onLockOwner?.(owner);
    }
    const result = await waitForExit(child, 5_000);
    return { ...result, output, pid: child.pid };
  } catch (error) {
    await terminateProcessGroup(child);
    throw new Error(`${args[0]} did not finish cleanly\n${output}`, { cause: error });
  }
}

function processGroupIsAlive(child) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessGroupExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupIsAlive(child);
}

async function terminateProcessGroup(child) {
  if (!child?.pid || !processGroupIsAlive(child)) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Re-check below.
  }
  if (!await waitForProcessGroupExit(child, 10_000)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Re-check below.
    }
    if (!await waitForProcessGroupExit(child, 2_000)) {
      throw new Error(`failed to terminate test process group ${child.pid}`);
    }
  }
  if (typeof child.once === "function") await waitForExit(child, 2_000);
}

async function readLockOwner() {
  try {
    const owner = JSON.parse(await readFile(JANUSLY_COMPOSE_LOCK_PATH, "utf8"));
    return Number.isSafeInteger(owner.pid) && typeof owner.token === "string"
      ? { pid: owner.pid, token: owner.token }
      : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function waitForLockOwner(pid, timeoutMs = 5_000) {
  let owner = null;
  await waitUntil(
    async () => {
      owner = await readLockOwner();
      return owner?.pid === pid;
    },
    timeoutMs,
    () => `lock owner did not become pid ${pid}`,
  );
  return owner;
}

async function removeOwnedLock(expectedOwner) {
  if (!expectedOwner) return;
  const currentOwner = await readLockOwner();
  if (currentOwner?.pid === expectedOwner.pid && currentOwner.token === expectedOwner.token) {
    await rm(JANUSLY_COMPOSE_LOCK_PATH, { force: true });
  }
}

async function terminateLoggedServiceGroups(logPath) {
  const lifecycle = await readOptional(logPath);
  const pids = [...lifecycle.matchAll(/^service pid (\d+)$/gm)]
    .map((match) => Number(match[1]));
  await Promise.all(pids.map((pid) => terminateProcessGroup({ pid })));
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

const fakeDockerSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const log = process.env.JANUSLY_DEV_TEST_LOG;
const args = process.argv.slice(2).join(" ");
appendFileSync(log, \`docker \${args}\\n\`);
if (args === "compose down") {
  appendFileSync(log, "compose down start\\n");
  if (process.env.JANUSLY_DEV_HANG_DOWN === "1") {
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 1_000);
  } else {
    setTimeout(() => {
      appendFileSync(log, "compose down done\\n");
      process.exit(0);
    }, 150);
  }
}
`;

const fakePnpmSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.JANUSLY_DEV_TEST_LOG, \`pnpm \${process.argv.slice(2).join(" ")}\\n\`);
`;

const fakeTsxSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const log = process.env.JANUSLY_DEV_TEST_LOG;
appendFileSync(log, \`service pid \${process.pid}\n\`);
const isApi = process.cwd().endsWith("/apps/api");
let server;
if (isApi) {
  server = createServer((_, response) => { response.writeHead(200); response.end("ok"); });
  server.listen(Number(process.env.PORT || 3001), "127.0.0.1", () => appendFileSync(log, "api ready\\n"));
} else {
  appendFileSync(log, "worker ready\\n");
  setInterval(() => {}, 1000);
}
function stop() {
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

const fakeViteSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const args = process.argv.slice(2);
appendFileSync(process.env.JANUSLY_DEV_TEST_LOG, \`service pid \${process.pid}\n\`);
const host = args[args.indexOf("--host") + 1];
const port = Number(args[args.indexOf("--port") + 1]);
const server = createServer((_, response) => { response.writeHead(200); response.end("Janusly"); });
server.listen(port, host, () => appendFileSync(process.env.JANUSLY_DEV_TEST_LOG, \`web ready \${args.join(" ")}\\n\`));
function stop() { server.close(() => process.exit(0)); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;
