// Boots the Go binary and runs the real React app's smoke against it:
//
//   node go/conformance/run-web-smoke.mjs
//
// Requires the pilot database up (make db-up + make migrate) and Playwright
// chromium installed (pnpm --filter @janusly/web exec playwright install
// chromium). The web dev server is owned by Playwright's webServer config;
// VITE_API_URL points it at the Go API.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const GO_DIR = join(REPO, "go");
const API = "http://127.0.0.1:4600";
const DB = process.env.JANUSLY_GO_DATABASE_URL
  ?? "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

// Pre-clean: the $0 fallback templates carry FIXED product-wide ids
// (approval-gate etc. — Node parity), so a previous smoke run's save
// blocks the next one's cross-org. The dev-only harness clears them.
const TEMPLATE_IDS = "'http-ai-summary','api-transform-tool','approval-gate','incident-triage','email-reply'";
const PG_CONTAINER = process.env.JANUSLY_GO_PG_CONTAINER ?? "janusly-go-pilot-postgres-1";
console.log("== pre-clean fallback template workflows ==");
try {
  await run("docker", ["exec", PG_CONTAINER, "psql", "-U", "janusly", "-d", "janusly_go", "-c",
    `DELETE FROM workflow_versions WHERE workflow_id IN (${TEMPLATE_IDS}); DELETE FROM workflows WHERE id IN (${TEMPLATE_IDS});`]);
} catch (error) {
  console.warn("template pre-clean skipped:", String(error));
}

console.log("== build go api ==");
await run("go", ["build", "-o", "/tmp/janusly-go-smoke-api", "./cmd/api"], { cwd: GO_DIR });

console.log("== boot go api on :4600 ==");
const api = spawn("/tmp/janusly-go-smoke-api", [], {
  env: {
    ...process.env,
    JANUSLY_GO_DATABASE_URL: DB,
    JANUSLY_GO_WORK_PLANE_ENABLED: "true",
    JANUSLY_GO_PORT: "4600",
    JANUSLY_GO_INTERNAL_PORT: "4601",
    JANUSLY_GO_POLL_MS: "50",
    // The operator-loop spec hosts its healable upstream on loopback.
    ALLOW_PRIVATE_HTTP_TARGETS: "true",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const stopApi = () => { try { api.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", stopApi);

for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`${API}/healthz`);
    if (res.ok) break;
  } catch { /* booting */ }
  await delay(200);
  if (i === 49) { stopApi(); throw new Error("go api never became healthy"); }
}

console.log("== playwright smoke (vite owned by playwright webServer) ==");
try {
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
  stopApi();
}
