// SDK-Python live lane: boots the Go binary with a service token,
// seeds the org membership + one saved workflow, and runs the SDK's
// pytest live module against the REAL wire:
//
//   node go/conformance/run-sdk-live.mjs
//
// Requires the pilot database up (make db-up + make migrate) and uv.

import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");
const SDK_DIR = join(GO_DIR, "..", "packages", "sdk-python");
const DB = process.env.JANUSLY_GO_DATABASE_URL
  ?? "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go";
const PG_CONTAINER = process.env.JANUSLY_GO_PG_CONTAINER ?? "janusly-go-pilot-postgres-1";
const PORT = "4670";
const STAMP = Date.now().toString(36);
const ORG = `sdk-live-${STAMP}`;
const TOKEN = `sdk-live-token-${STAMP}`;
const WORKFLOW_ID = `sdk-live-wf-${STAMP}`;

console.error("== sdk-live: build + boot go api ==");
execFileSync("go", ["build", "-o", "/tmp/janusly-go-sdk-api", "./cmd/api"], { cwd: GO_DIR, stdio: "inherit" });
const api = spawn("/tmp/janusly-go-sdk-api", [], {
  env: {
    ...process.env,
    JANUSLY_GO_DATABASE_URL: DB,
    JANUSLY_GO_WORK_PLANE_ENABLED: "true",
    JANUSLY_GO_PORT: PORT,
    JANUSLY_GO_INTERNAL_PORT: "4671",
    JANUSLY_GO_POLL_MS: "50",
    JANUSLY_API_SERVICE_TOKEN: TOKEN,
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const stopApi = () => { try { api.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", stopApi);
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
  } catch { /* booting */ }
  if (i > 60) { stopApi(); throw new Error("go api never became healthy"); }
  await delay(250);
}

console.error("== sdk-live: seed membership (service-token mode never auto-grants) ==");
execFileSync("docker", ["exec", PG_CONTAINER, "psql", "-U", "janusly", "-d", "janusly_go", "-c",
  `INSERT INTO org_members (id, org_id, user_id, role) VALUES ('${ORG}-member', '${ORG}', 'sdk-live', 'admin')`],
{ stdio: "inherit" });

console.error("== sdk-live: seed one saved workflow (dev-header wire) ==");
const save = await fetch(`http://127.0.0.1:${PORT}/workflows/save`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-org-id": ORG, "x-user-id": "sdk-live" },
  body: JSON.stringify({
    id: WORKFLOW_ID, name: "SDK live", dslVersion: "1.0",
    nodes: [
      { id: "shape", type: "transform", config: { mapping: { verdict: "ok" } } },
      { id: "done", type: "noop", config: {} },
    ],
    edges: [{ from: "shape", to: "done" }],
  }),
});
if (!save.ok) { stopApi(); throw new Error(`seed save failed: ${save.status}`); }

console.error("== sdk-live: pytest ==");
let code = 1;
try {
  execFileSync("uv", ["run", "--frozen", "--extra", "dev", "pytest", "tests/test_live_go.py", "-q"], {
    cwd: SDK_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      JANUSLY_SDK_LIVE_URL: `http://127.0.0.1:${PORT}`,
      JANUSLY_SDK_LIVE_TOKEN: TOKEN,
      JANUSLY_SDK_LIVE_ORG: ORG,
      JANUSLY_SDK_LIVE_WF: WORKFLOW_ID,
    },
  });
  code = 0;
  console.log("== sdk-live green ==");
} finally {
  stopApi();
  process.exitCode = code;
}
