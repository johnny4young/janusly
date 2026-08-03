// Boots the Go binary and runs the real React app's smoke against it:
//
//   node go/conformance/run-web-smoke.mjs
//
// Requires an already migrated database and Playwright chromium. The safe
// qualification entrypoint is run-web-qualification.mjs, which owns an
// ephemeral PostgreSQL 18 project. The web dev server is owned by Playwright's
// webServer config; VITE_API_URL points it at the Go API.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, unlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const GO_DIR = join(REPO, "go");
const API_PORT = Number(process.env.JANUSLY_GO_SMOKE_API_PORT ?? "4600");
const INTERNAL_PORT = Number(process.env.JANUSLY_GO_SMOKE_INTERNAL_PORT ?? "4601");
if (![API_PORT, INTERNAL_PORT].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) ||
    API_PORT === INTERNAL_PORT) {
  throw new Error("JANUSLY_GO_SMOKE_API_PORT and JANUSLY_GO_SMOKE_INTERNAL_PORT must be distinct integers in [1024, 65535]");
}
const API = `http://127.0.0.1:${API_PORT}`;
const DB = process.env.JANUSLY_GO_DATABASE_URL
  ?? "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go";
const BINARY = `/tmp/janusly-go-smoke-api-${process.pid}`;
const removeBinary = () => { try { unlinkSync(BINARY); } catch { /* task-owned scratch already gone */ } };

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.once("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// Pre-clean: the $0 fallback templates carry FIXED product-wide ids
// (approval-gate etc. — Node parity), so a previous smoke run's save
// blocks the next one's cross-org. The dev-only harness clears them.
const TEMPLATE_IDS = "'http-ai-summary','api-transform-tool','approval-gate','incident-triage','email-reply'";
const PG_CONTAINER = process.env.JANUSLY_GO_PG_CONTAINER ?? "janusly-go-pilot-postgres-1";
const PG_DATABASE = process.env.JANUSLY_GO_PG_DATABASE ?? "janusly_go";
if (!/^[a-zA-Z0-9_]+$/u.test(PG_DATABASE)) throw new Error("JANUSLY_GO_PG_DATABASE must be a simple database name");
if (process.env.JANUSLY_GO_SMOKE_SKIP_PRECLEAN !== "true") {
  if (process.env.JANUSLY_GO_SMOKE_CONFIRM_PRECLEAN !== "true") {
    throw new Error("shared-database template cleanup requires JANUSLY_GO_SMOKE_CONFIRM_PRECLEAN=true; use run-web-qualification.mjs for isolated qualification");
  }
  console.log("== pre-clean fallback template workflows ==");
  try {
    await run("docker", ["exec", PG_CONTAINER, "psql", "-U", "janusly", "-d", PG_DATABASE, "-c",
      `DELETE FROM workflow_versions WHERE workflow_id IN (${TEMPLATE_IDS}); DELETE FROM workflows WHERE id IN (${TEMPLATE_IDS});`]);
  } catch (error) {
    console.warn("template pre-clean skipped:", String(error));
  }
}

console.log("== build go api ==");
if (existsSync(BINARY)) throw new Error(`smoke scratch binary already exists: ${BINARY}`);
try {
  await run("go", ["build", "-o", BINARY, "./cmd/api"], { cwd: GO_DIR });
} catch (error) {
  removeBinary();
  throw error;
}

console.log(`== boot go api on :${API_PORT} ==`);
const api = spawn(BINARY, [], {
  env: {
    ...process.env,
    JANUSLY_GO_DATABASE_URL: DB,
    JANUSLY_GO_WORK_PLANE_ENABLED: "true",
    JANUSLY_GO_PORT: String(API_PORT),
    JANUSLY_GO_INTERNAL_HOST: "127.0.0.1",
    JANUSLY_GO_INTERNAL_PORT: String(INTERNAL_PORT),
    JANUSLY_GO_POLL_MS: "50",
    // The operator-loop spec hosts its healable upstream on loopback.
    ALLOW_PRIVATE_HTTP_TARGETS: "true",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let apiSpawnError;
api.once("error", error => { apiSpawnError = error; });
const stopApiOnExit = () => { try { api.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", () => {
  stopApiOnExit();
  removeBinary();
});
async function stopApi() {
  if (apiSpawnError || api.exitCode !== null || api.signalCode !== null) return;
  const closed = once(api, "close");
  try { api.kill("SIGTERM"); } catch { return; }
  await Promise.race([closed, delay(5_000)]);
  if (api.exitCode === null && api.signalCode === null) {
    const killed = once(api, "close");
    try { api.kill("SIGKILL"); } catch { return; }
    await killed;
  }
}

try {
  for (let i = 0; i < 50; i++) {
    if (apiSpawnError) throw apiSpawnError;
    if (api.exitCode !== null || api.signalCode !== null) {
      throw new Error(`go api exited before becoming healthy (${api.exitCode ?? api.signalCode})`);
    }
    try {
      const res = await fetch(`${API}/healthz`);
      if (res.ok) break;
    } catch { /* booting */ }
    await delay(200);
    if (i === 49) throw new Error("go api never became healthy");
  }

  console.log("== playwright smoke (vite owned by playwright webServer) ==");
  await run("pnpm", ["--filter", "@janusly/web", "exec", "playwright", "test", "e2e/go-pilot-smoke.spec.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      JANUSLY_GO_SMOKE: "1",
      E2E_API_URL: API,
      VITE_API_URL: API,
    },
  });
  console.log("== web smoke green ==");
} finally {
  await stopApi();
  removeBinary();
}
