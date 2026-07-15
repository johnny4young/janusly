/** Concurrency and stale-owner coverage for the local process lock. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireProcessLock } from "./process-lock.mjs";

test("process lock serializes concurrent owners and releases idempotently", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    const releaseFirst = await acquireProcessLock(lockPath, { pollMs: 10 });
    let secondAcquired = false;
    const second = acquireProcessLock(lockPath, { pollMs: 10 }).then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondAcquired, false);

    await releaseFirst();
    await releaseFirst();
    const releaseSecond = await second;
    assert.equal(secondAcquired, true);
    await releaseSecond();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("process lock reclaims a dead stale owner", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-stale-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: 0 }),
      "utf8",
    );
    const release = await acquireProcessLock(lockPath, {
      pollMs: 1,
      staleGraceMs: 0,
    });
    await release();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("process lock reclaims a dead stale atomic owner file", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-stale-file-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, startedAt: 0, token: "dead-file-owner" }),
      "utf8",
    );
    const release = await acquireProcessLock(lockPath, {
      pollMs: 1,
      staleGraceMs: 0,
    });
    await release();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an old release cannot remove a newer lock generation from the same process", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-generation-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    const releaseFirst = await acquireProcessLock(lockPath);
    await rm(lockPath, { recursive: true, force: true });
    const releaseSecond = await acquireProcessLock(lockPath);
    const secondOwner = await readFile(lockPath, "utf8");

    await releaseFirst();
    assert.equal(await readFile(lockPath, "utf8"), secondOwner);
    await releaseSecond();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a live stale-lock reclaimer backs off and times out", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-reclaim-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: 0, token: "dead-owner" }),
      "utf8",
    );
    await rename(
      join(lockPath, "owner.json"),
      join(lockPath, `.reclaim-${process.pid}-busy.json`),
    );

    const startedAt = Date.now();
    await assert.rejects(
      acquireProcessLock(lockPath, { pollMs: 5, staleGraceMs: 0, timeoutMs: 30 }),
      /timed out waiting for process lock/,
    );
    assert.ok(Date.now() - startedAt >= 20);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("process lock takes over an abandoned stale reclaim generation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-abandoned-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: 0, token: "dead-owner" }),
      "utf8",
    );
    await rename(
      join(lockPath, "owner.json"),
      join(lockPath, ".reclaim-2147483646-abandoned.json"),
    );

    const release = await acquireProcessLock(lockPath, { pollMs: 1, staleGraceMs: 0 });
    await release();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("process lock recovers a legacy ownerless directory after the grace period", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-ownerless-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    await mkdir(lockPath);
    const release = await acquireProcessLock(lockPath, { pollMs: 1, staleGraceMs: 0 });
    await release();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("process lock recovers a legacy malformed owner after the grace period", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "janusly-process-lock-malformed-"));
  const lockPath = join(sandbox, "e2e.lock");
  try {
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), "{", "utf8");
    const release = await acquireProcessLock(lockPath, { pollMs: 1, staleGraceMs: 0 });
    await release();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
