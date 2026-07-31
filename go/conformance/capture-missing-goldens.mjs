// Recaptures the goldens the first pass missed — save SUCCESS (the body is
// the workflow document at the TOP level, not {workflow}), the dlq replay
// pair, and the cancel guard ladder. Run against the pinned reference stack:
//
//   node go/conformance/capture-missing-goldens.mjs

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.GOLDENS_API_URL ?? "http://localhost:3001";
const ORG = "golden2-org";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "goldens", "node");
const captures = [];

async function call(name, method, path, body, { org = ORG } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", "x-org-id": org, "x-user-id": "golden2" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  captures.push([name, {
    request: { method, path, ...(body === undefined ? {} : { body }) },
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type"),
      "x-request-id": res.headers.get("x-request-id") ? "<present>" : null,
    },
    body: parsed,
  }]);
  return parsed;
}

async function waitRun(runId, want, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/status?runId=${runId}`, {
      headers: { "x-org-id": ORG, "x-user-id": "golden2" },
    });
    const body = await res.json();
    const status = body?.run?.status ?? body?.data?.run?.status;
    if (want.includes(status)) return status;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`run ${runId} never reached ${want}`);
}

// 1. Save SUCCESS — the body is the workflow document itself.
const doc = {
  id: "golden2-save",
  name: "Golden save success",
  nodes: [{ id: "only", type: "noop", config: {} }],
  edges: [],
};
await call("workflows-save-success", "POST", "/v1/workflows/save", doc);
await call("workflows-save-second-version", "POST", "/v1/workflows/save", doc);

// 2. DLQ replay pair: fail a run terminally, replay, replay again.
const doomed = {
  id: "golden2-doomed",
  nodes: [{ id: "blocked", type: "http", config: { url: "http://169.254.169.254/x" } }],
  edges: [],
};
const started = await call("start-doomed-2", "POST", "/v1/start", { workflow: doomed });
const runId = started?.data?.runId ?? started?.runId;
await waitRun(runId, ["failed"]);
const dlq = await call("dlq-list-2", "GET", "/v1/dlq?limit=10");
const rows = dlq?.data ?? [];
const row = rows.find((r) => r.runId === runId);
if (!row) throw new Error("no dead letter captured");
await call("dlq-replay", "POST", "/v1/dlq/replay", { deadLetterId: row.id });
await call("dlq-replay-conflict", "POST", "/v1/dlq/replay", { deadLetterId: row.id });

// 3. Cancel ladder: missing id, unknown run, cross-org, success, terminal.
const gate = {
  id: "golden2-gate",
  nodes: [{ id: "gate", type: "approval", config: { message: "hold" } }],
  edges: [],
};
const gateStart = await call("start-gate-2", "POST", "/v1/start", { workflow: gate });
const gateRunId = gateStart?.data?.runId ?? gateStart?.runId;
await call("cancel-missing-id", "POST", "/v1/run/cancel", {});
await call("cancel-unknown", "POST", "/v1/run/cancel", { runId: "ghost-run" });
await call("cancel-cross-org", "POST", "/v1/run/cancel", { runId: gateRunId }, { org: "other2-org" });
await call("cancel-success", "POST", "/v1/run/cancel", { runId: gateRunId, reason: { why: "golden" } });
await call("cancel-terminal", "POST", "/v1/run/cancel", { runId: gateRunId });

await mkdir(OUT, { recursive: true });
for (const [name, record] of captures) {
  await writeFile(join(OUT, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
}
console.log(`captured ${captures.length} goldens`);
