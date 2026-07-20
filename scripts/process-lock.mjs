/** Conservative filesystem lock for destructive local orchestrators. */

import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const OWNER_FILE = "owner.json";
const COMPOSE_PULL_POLICIES = new Set(["always", "missing", "never"]);
const sharedTempDir = process.platform === "win32" ? tmpdir() : "/tmp";
export const JANUSLY_COMPOSE_LOCK_PATH = join(
  sharedTempDir,
  "janusly-compose-6379-5432.lock",
);

/** Map the optional local pull override to Docker Compose's explicit CLI flag. */
export function composeUpPullArgs(policy = process.env.COMPOSE_PULL_POLICY) {
  if (!policy) return [];
  if (!COMPOSE_PULL_POLICIES.has(policy)) {
    throw new Error(
      `COMPOSE_PULL_POLICY must be one of always, missing, or never; received ${policy}`,
    );
  }
  return ["--pull", policy];
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readOwner(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    return Number.isSafeInteger(parsed.pid)
      && parsed.pid > 0
      && typeof parsed.token === "string"
      && parsed.token.length > 0
      ? { pid: parsed.pid, token: parsed.token, startedAt: parsed.startedAt }
      : null;
  } catch (error) {
    if (error?.code !== "EISDIR") return null;
    try {
      const parsed = JSON.parse(await readFile(`${lockPath}/${OWNER_FILE}`, "utf8"));
      return Number.isSafeInteger(parsed.pid)
        && parsed.pid > 0
        && typeof parsed.token === "string"
        && parsed.token.length > 0
        ? { pid: parsed.pid, token: parsed.token, startedAt: parsed.startedAt }
        : null;
    } catch {
      return null;
    }
  }
}

async function lockExists(lockPath) {
  try {
    // Do not follow symlinks here: a dangling link still occupies the canonical
    // path and must fail closed instead of making acquisition spin forever.
    await lstat(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sameOwner(left, right) {
  return Boolean(left && right && left.token === right.token);
}

function lockConflictError(lockPath, owner) {
  if (owner && processIsAlive(owner.pid)) {
    return new Error(`Janusly Compose lifecycle already running under pid ${owner.pid} (${lockPath})`);
  }
  return new Error(
    `Stale Janusly Compose lifecycle lock at ${lockPath}. `
      + "Verify no Janusly child processes or Compose services remain, then remove it manually.",
  );
}

/**
 * Acquire an atomic file lock and return its idempotent release function.
 *
 * The lock is intentionally never reclaimed automatically. If the owner is
 * killed abruptly, its API/worker/Playwright descendants may still be alive;
 * preserving the file prevents a new destructive Compose generation from
 * overlapping them. Manual recovery is explicit after the operator verifies
 * the old process tree and containers are gone. Manual cleanup while an owner
 * is alive is outside the contract. During supported execution the canonical
 * file cannot be replaced between the token read and unlink because contenders
 * can only publish with an exclusive hard link while that path remains present.
 */
export async function acquireProcessLock(lockPath) {
  await mkdir(dirname(lockPath), { recursive: true });
  const owner = { pid: process.pid, token: randomUUID(), startedAt: Date.now() };
  const candidatePath = `${lockPath}.${owner.token}.candidate`;

  while (true) {
    await writeFile(candidatePath, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
    try {
      await link(candidatePath, lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const currentOwner = await readOwner(lockPath);
      if (await lockExists(lockPath)) throw lockConflictError(lockPath, currentOwner);
    } finally {
      await rm(candidatePath, { force: true });
    }
  }

  let releasePromise = null;
  return () => {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      if (sameOwner(await readOwner(lockPath), owner)) {
        await rm(lockPath, { force: true });
      }
    })();
    return releasePromise;
  };
}

/** Serialize every local orchestrator that owns Janusly's fixed Compose ports. */
export function acquireJanuslyComposeLock() {
  if (process.platform === "win32") {
    throw new Error(
      "Janusly Compose orchestrators require macOS, Linux, or WSL for process-group fencing",
    );
  }
  return acquireProcessLock(JANUSLY_COMPOSE_LOCK_PATH);
}
