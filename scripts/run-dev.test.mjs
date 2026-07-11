/** Unit and subprocess lifecycle coverage for the root development orchestrator. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_DEV_HOST, devWebUrl, resolveDevHost, viteArgs } from "./run-dev-config.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

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

test("development orchestrator waits for readiness and awaited Compose teardown", { timeout: 30_000 }, async (t) => {
  if (!(await portsAreFree([3001, 5173]))) {
    t.skip("development ports 3001/5173 are already in use");
    return;
  }

  const sandbox = await mkdtemp(join(tmpdir(), "janusly-run-dev-"));
  const logPath = join(sandbox, "lifecycle.log");
  let child;
  try {
    await Promise.all([
      writeExecutable(sandbox, "docker", fakeDockerSource),
      writeExecutable(sandbox, "pnpm", fakePnpmSource),
      writeExecutable(sandbox, "tsx", fakeTsxSource),
      writeExecutable(sandbox, "vite", fakeViteSource),
    ]);

    child = spawn(process.execPath, ["scripts/run-dev.mjs"], {
      cwd: rootDir,
      env: {
        ...process.env,
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
    const response = await fetch("http://127.0.0.1:5173");
    assert.equal(response.status, 200);

    const exited = waitForExit(child);
    child.kill("SIGINT");
    const { code, signal } = await exited;
    assert.equal(signal, null);
    assert.equal(code, 0, output);

    const lifecycle = await readFile(logPath, "utf8");
    assert.match(lifecycle, /docker compose up -d redis postgres ollama/);
    assert.match(lifecycle, /pnpm migrate/);
    assert.match(lifecycle, /api ready/);
    assert.match(lifecycle, /web ready --host 127\.0\.0\.1 --port 5173 --strictPort/);
    assert.ok(lifecycle.indexOf("compose down start") < lifecycle.indexOf("compose down done"));
    assert.ok(output.indexOf("[dev] shutting down") < output.length);
    await assert.rejects(fetch("http://127.0.0.1:5173"));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for condition\n${details()}`);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

const fakeDockerSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const log = process.env.JANUSLY_DEV_TEST_LOG;
const args = process.argv.slice(2).join(" ");
appendFileSync(log, \`docker \${args}\\n\`);
if (args === "compose down") {
  appendFileSync(log, "compose down start\\n");
  setTimeout(() => {
    appendFileSync(log, "compose down done\\n");
    process.exit(0);
  }, 150);
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
const host = args[args.indexOf("--host") + 1];
const port = Number(args[args.indexOf("--port") + 1]);
const server = createServer((_, response) => { response.writeHead(200); response.end("Janusly"); });
server.listen(port, host, () => appendFileSync(process.env.JANUSLY_DEV_TEST_LOG, \`web ready \${args.join(" ")}\\n\`));
function stop() { server.close(() => process.exit(0)); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;
