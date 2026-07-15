/** Serialization, fencing, and conservative crash coverage for process locks. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireProcessLock, composeUpPullArgs } from "./process-lock.mjs";

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForReady(child) {
  return withTimeout(new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(new Error(`lock owner exited before readiness (${code ?? signal})`));
    });
  }), 5_000, "timed out waiting for lock owner readiness");
}

function waitForExit(child) {
  return withTimeout(new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }), 5_000, "timed out waiting for lock owner exit");
}

test("process lock rejects a concurrent owner and releases idempotently", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    const release = await acquireProcessLock(lockPath);
    await assert.rejects(acquireProcessLock(lockPath), /already running/);
    await Promise.all([release(), release()]);
    const releaseNext = await acquireProcessLock(lockPath);
    await releaseNext();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Compose pull override maps only supported policies to explicit CLI arguments", () => {
  assert.deepEqual(composeUpPullArgs(""), []);
  assert.deepEqual(composeUpPullArgs("always"), ["--pull", "always"]);
  assert.deepEqual(composeUpPullArgs("never"), ["--pull", "never"]);
  assert.deepEqual(composeUpPullArgs("missing"), ["--pull", "missing"]);
  assert.throws(
    () => composeUpPullArgs("sometimes"),
    /must be one of always, missing, or never/,
  );
});

test("an old release cannot remove a newer generation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-generation-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    const releaseOld = await acquireProcessLock(lockPath);
    await rm(lockPath, { force: true });
    const releaseNew = await acquireProcessLock(lockPath);
    const newOwner = await readFile(lockPath, "utf8");

    await releaseOld();
    assert.equal(await readFile(lockPath, "utf8"), newOwner);
    await releaseNew();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an abrupt owner exit leaves a conservative manual-recovery lock", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-crash-"));
  const lockPath = join(sandbox, "e2e.lock");
  const moduleUrl = new URL("./process-lock.mjs", import.meta.url).href;
  let child;
  try {
    child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { acquireProcessLock } from ${JSON.stringify(moduleUrl)};`
        + `await acquireProcessLock(${JSON.stringify(lockPath)});`
        + `process.stdout.write("ready\\n");`
        + `setInterval(() => {}, 1_000);`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForReady(child);
    const exitPromise = waitForExit(child);
    child.kill("SIGKILL");
    const exit = await exitPromise;
    assert.equal(exit.signal, "SIGKILL");
    await assert.rejects(acquireProcessLock(lockPath), /Stale Janusly Compose lifecycle lock/);

    await rm(lockPath, { recursive: true, force: true });
    const release = await acquireProcessLock(lockPath);
    await release();
  } finally {
    try {
      if (child?.exitCode === null && child?.signalCode === null) {
        const forcedExit = waitForExit(child);
        child.kill("SIGKILL");
        await forcedExit;
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  }
});

test("an incomplete lock blocks instead of being reclaimed unsafely", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-incomplete-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), "{", "utf8");
    await assert.rejects(acquireProcessLock(lockPath), /Stale Janusly Compose lifecycle lock/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a dangling lock symlink blocks instead of spinning acquisition", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-symlink-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    await symlink(join(sandbox, "missing-owner"), lockPath);
    await assert.rejects(
      withTimeout(
        acquireProcessLock(lockPath),
        1_000,
        "dangling lock acquisition did not fail closed",
      ),
      /Stale Janusly Compose lifecycle lock/,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
