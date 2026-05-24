#!/usr/bin/env node
/**
 * Dev port doctor — frees the host-side dev ports (api :3001, web :5173)
 * when a previous `pnpm dev` left orphan processes behind, which surfaces
 * to the user as:
 *
 *     Error: listen EADDRINUSE: address already in use :::3001
 *
 * Use:
 *   pnpm dev:doctor              # kill orphans on :3001 and :5173
 *   pnpm dev:doctor --compose    # also `docker compose down` so postgres + redis go too
 *
 * Behaviour:
 *  - Scans :3001 and :5173 via `lsof -ti tcp:<port>`. macOS / Linux compatible.
 *  - For each PID found: SIGTERM → wait 2s → SIGKILL if still alive.
 *  - Never touches postgres / redis by PID (they live inside Compose and
 *    are torn down with the `--compose` flag).
 *  - Idempotent — running it when ports are free is a no-op that prints
 *    "all dev ports already free".
 *  - Never throws; exits 0 unless `--compose` was requested AND
 *    `docker compose down` failed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Ports the host-side dev stack listens on. Postgres :5432 and Redis :6379
 * live inside Compose; this script never touches them by PID.
 */
const HOST_PORTS = [
  { port: 3001, label: "api (apps/api)" },
  { port: 5173, label: "web (apps/web)" },
];

const KILL_GRACE_MS = 2_000;
const composeFlag = process.argv.includes("--compose");

/** Return PIDs listening on the given TCP port, or [] when none. */
async function pidsOnPort(port) {
  try {
    const { stdout } = await run("lsof", ["-ti", `tcp:${port}`]);
    return stdout
      .trim()
      .split("\n")
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    // `lsof` exits non-zero when there are no matches; treat as "port free".
    return [];
  }
}

/** Best-effort liveness check via signal 0. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM, wait the grace, SIGKILL survivors. Returns true when the PID is gone. */
async function killGracefully(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone — nothing to do.
  }
  await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Race with the parent reaping it — fine.
    }
  }
  return !alive(pid);
}

async function main() {
  let anyKilled = false;

  for (const { port, label } of HOST_PORTS) {
    const pids = await pidsOnPort(port);
    if (pids.length === 0) {
      console.log(`[dev-doctor] :${port} ${label} — free`);
      continue;
    }
    console.log(
      `[dev-doctor] :${port} ${label} — ${pids.length} PID(s) ${pids.join(", ")}, killing…`,
    );
    for (const pid of pids) {
      const ok = await killGracefully(pid);
      console.log(
        `[dev-doctor]   PID ${pid} → ${ok ? "killed" : "still alive (manual intervention)"}`,
      );
      if (ok) anyKilled = true;
    }
  }

  if (composeFlag) {
    console.log("[dev-doctor] docker compose down…");
    try {
      const { stdout, stderr } = await run("docker", ["compose", "down"]);
      if (stderr.trim()) console.log(stderr.trim());
      if (stdout.trim()) console.log(stdout.trim());
      console.log("[dev-doctor] compose down ✓");
    } catch (err) {
      console.error("[dev-doctor] compose down failed:", err?.message ?? err);
      process.exitCode = 1;
    }
  }

  if (!anyKilled && !composeFlag) {
    console.log("[dev-doctor] all dev ports already free.");
  }
}

main().catch((err) => {
  console.error("[dev-doctor] fatal:", err?.message ?? err);
  process.exit(1);
});
