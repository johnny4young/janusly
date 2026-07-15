/** Atomic process lock used to serialize destructive local orchestrators. */

import { randomUUID } from "node:crypto";
import { link, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OWNER_FILE = "owner.json";
const RECLAIM_PREFIX = ".reclaim-";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function readOwnerFile(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const owner = {
      pid: Number(parsed.pid),
      startedAt: Number(parsed.startedAt),
      token: typeof parsed.token === "string" ? parsed.token : null,
    };
    return Number.isSafeInteger(owner.pid)
      && owner.pid > 0
      && Number.isFinite(owner.startedAt)
      && owner.startedAt >= 0
      ? owner
      : null;
  } catch {
    return null;
  }
}

function readOwner(lockPath) {
  return readOwnerFile(join(lockPath, OWNER_FILE));
}

async function readLockState(lockPath) {
  try {
    const metadata = await lstat(lockPath);
    if (metadata.isFile()) {
      return { kind: "file", mtimeMs: metadata.mtimeMs, owner: await readOwnerFile(lockPath) };
    }
    if (metadata.isDirectory()) {
      return { kind: "directory", mtimeMs: metadata.mtimeMs, owner: await readOwner(lockPath) };
    }
    return { kind: "unsupported", mtimeMs: metadata.mtimeMs, owner: null };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameOwner(left, right) {
  if (!left || !right) return left === right;
  if (left.token || right.token) return left.token !== null && left.token === right.token;
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

function ownerIsStale(owner, staleGraceMs) {
  return Date.now() - owner.startedAt >= staleGraceMs && !processIsAlive(owner.pid);
}

function reclaimFileName() {
  return `${RECLAIM_PREFIX}${process.pid}-${randomUUID()}.json`;
}

function siblingClaimPath(lockPath, prefix) {
  return `${lockPath}.${prefix}-${process.pid}-${randomUUID()}`;
}

function reclaimClaimantPid(name) {
  const match = /^\.reclaim-(\d+)-.+\.json$/.exec(name);
  return match ? Number(match[1]) : null;
}

async function listReclaimClaims(lockPath) {
  try {
    const names = (await readdir(lockPath)).filter((name) => name.startsWith(RECLAIM_PREFIX));
    return Promise.all(names.map(async (name) => ({
      name,
      claimantPid: reclaimClaimantPid(name),
      originalOwner: await readOwnerFile(join(lockPath, name)),
    })));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function reclaimStaleLock(lockPath, sourceName, observedOwner, staleGraceMs) {
  const sourcePath = join(lockPath, sourceName);
  const claimPath = join(lockPath, reclaimFileName());
  try {
    await rename(sourcePath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  let removed = false;
  try {
    const claimedOwner = await readOwnerFile(claimPath);
    if (!sameOwner(observedOwner, claimedOwner)
      || !claimedOwner
      || !ownerIsStale(claimedOwner, staleGraceMs)) return false;
    await rm(lockPath, { recursive: true, force: true });
    removed = true;
    return true;
  } finally {
    if (!removed) {
      try {
        await rename(claimPath, sourcePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

async function reclaimStaleFileLock(lockPath, observedOwner, staleGraceMs) {
  const claimPath = siblingClaimPath(lockPath, "reclaim");
  try {
    await rename(lockPath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  let removed = false;
  try {
    const claimedOwner = await readOwnerFile(claimPath);
    if (!sameOwner(observedOwner, claimedOwner)
      || !claimedOwner
      || !ownerIsStale(claimedOwner, staleGraceMs)) return false;
    await rm(claimPath, { force: true });
    removed = true;
    return true;
  } finally {
    if (!removed) {
      try {
        await rename(claimPath, lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
      }
    }
  }
}

async function reclaimInvalidLegacyLock(lockPath, observedMtimeMs, staleGraceMs) {
  if (Date.now() - observedMtimeMs < staleGraceMs) return false;
  const claimPath = siblingClaimPath(lockPath, "invalid");
  try {
    await rename(lockPath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await rm(claimPath, { recursive: true, force: true });
  return true;
}

async function publishOwner(lockPath, owner) {
  const candidatePath = siblingClaimPath(lockPath, "candidate");
  await writeFile(candidatePath, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
  try {
    await link(candidatePath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(candidatePath, { force: true });
  }
}

/**
 * Acquire an atomic process lock and return its idempotent release function.
 * The immutable owner file is fully written before an atomic hard link makes
 * it visible, so a creator crash can leave only a non-blocking candidate.
 * Legacy directory locks remain readable and reclaimable during upgrades.
 */
export async function acquireProcessLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const staleGraceMs = options.staleGraceMs ?? 5_000;
  const startedWaitingAt = Date.now();
  let announcedWait = false;

  while (true) {
    const owner = { pid: process.pid, startedAt: Date.now(), token: randomUUID() };
    if (await publishOwner(lockPath, owner)) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const currentOwner = await readOwnerFile(lockPath);
        if (sameOwner(currentOwner, owner)) {
          await rm(lockPath, { force: true });
        }
      };
    }

    const state = await readLockState(lockPath);
    if (!state) continue;
    let waitingOwner = state.owner;
    if (state.kind === "file") {
      if (state.owner && ownerIsStale(state.owner, staleGraceMs)) {
        if (await reclaimStaleFileLock(lockPath, state.owner, staleGraceMs)) continue;
      } else if (!state.owner
        && await reclaimInvalidLegacyLock(lockPath, state.mtimeMs, staleGraceMs)) {
        continue;
      }
    } else if (state.kind === "directory" && state.owner) {
      if (ownerIsStale(state.owner, staleGraceMs)
        && await reclaimStaleLock(lockPath, OWNER_FILE, state.owner, staleGraceMs)) continue;
    } else if (state.kind === "directory") {
      const claims = await listReclaimClaims(lockPath);
      const abandoned = claims.find((claim) => claim.originalOwner
        && !processIsAlive(claim.claimantPid)
        && ownerIsStale(claim.originalOwner, staleGraceMs));
      if (abandoned?.originalOwner) {
        waitingOwner = abandoned.originalOwner;
        if (await reclaimStaleLock(
          lockPath,
          abandoned.name,
          abandoned.originalOwner,
          staleGraceMs,
        )) continue;
      } else if (claims.length === 0
        && await reclaimInvalidLegacyLock(lockPath, state.mtimeMs, staleGraceMs)) {
        continue;
      }
    } else if (await reclaimInvalidLegacyLock(lockPath, state.mtimeMs, staleGraceMs)) {
      continue;
    }

    if (Date.now() - startedWaitingAt >= timeoutMs) {
      throw new Error(`timed out waiting for process lock ${lockPath}`);
    }
    if (!announcedWait) {
      announcedWait = true;
      console.error(`[lock] waiting for pid ${waitingOwner?.pid ?? "unknown"} to release ${lockPath}`);
    }
    await sleep(pollMs);
  }
}
