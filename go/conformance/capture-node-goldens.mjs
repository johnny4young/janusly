// Captures the reference backend's real wire responses as golden files.
// Run it against a locally booted reference stack (API on :3001 with dev
// auth headers enabled) from the repo root:
//
//   node go/conformance/capture-node-goldens.mjs
//
// Output lands in go/conformance/goldens/node/*.json. Values are captured
// verbatim (ids and timestamps vary run to run) — consumers compare SHAPES:
// key sets, envelope fields, status codes, error bodies.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.GOLDENS_API_URL ?? "http://localhost:3001";
const ORG = "golden-org";
const USER = "golden-user";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "goldens", "node");

const captures = [];

async function call(name, method, path, body, { org = ORG } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-org-id": org,
      "x-user-id": USER,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const record = {
    request: { method, path, ...(body === undefined ? {} : { body }) },
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type"),
      "x-request-id": res.headers.get("x-request-id") ? "<present>" : null,
    },
    body: parsed,
  };
  captures.push([name, record]);
  return parsed;
}

async function waitForRun(runId, want, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/status?runId=${runId}`, {
      headers: { "x-org-id": ORG, "x-user-id": USER },
    });
    const body = await res.json();
    const status = body?.data?.status ?? body?.data?.run?.status ?? body?.run?.status ?? body?.status;
    if (want.includes(status)) return status;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`run ${runId} never reached ${want}`);
}

const linearWorkflow = {
  id: "golden-linear",
  name: "Golden linear",
  nodes: [
    { id: "shape", type: "transform", config: { mapping: { verdict: "ok", total: 3 } } },
    { id: "done", type: "noop", config: {} },
  ],
  edges: [{ from: "shape", to: "done" }],
};

const approvalWorkflow = {
  id: "golden-approval",
  name: "Golden approval",
  nodes: [
    { id: "gate", type: "approval", config: { message: "Golden gate" } },
    { id: "after", type: "noop", config: {} },
  ],
  edges: [{ from: "gate", to: "after" }],
};

const doomedWorkflow = {
  id: "golden-doomed",
  name: "Golden doomed",
  nodes: [
    { id: "blocked", type: "http", config: { url: "http://169.254.169.254/latest/meta-data/" } },
  ],
  edges: [],
};

// 1. Save + start + terminal reads.
await call("workflows-save", "POST", "/v1/workflows/save", { workflow: linearWorkflow });
const started = await call("start", "POST", "/v1/start", { workflow: linearWorkflow });
const runId = started?.data?.runId ?? started?.runId;
await waitForRun(runId, ["succeeded"]);
await call("status-succeeded", "GET", `/v1/status?runId=${runId}`);
await call("run-succeeded", "GET", `/v1/run?runId=${runId}`);
await call("runs-list", "GET", "/v1/runs?limit=5");

// 2. Approval pause + resume.
const approvalStarted = await call("start-approval", "POST", "/v1/start", { workflow: approvalWorkflow });
const approvalRunId = approvalStarted?.data?.runId ?? approvalStarted?.runId;
await waitForRun(approvalRunId, ["waiting", "running"]);
// Poll until the gate node itself waits.
for (let i = 0; i < 100; i++) {
  const res = await fetch(`${API}/run?runId=${approvalRunId}`, {
    headers: { "x-org-id": ORG, "x-user-id": USER },
  });
  const body = await res.json();
  const nodes = body?.data?.nodes ?? body?.nodes ?? [];
  if (nodes.some((n) => n.nodeId === "gate" && n.status === "waiting")) break;
  await new Promise((r) => setTimeout(r, 150));
}
await call("run-waiting", "GET", `/v1/run?runId=${approvalRunId}`);
await call("resume", "POST", "/v1/resume", { runId: approvalRunId, nodeId: "gate" });
await call("resume-conflict", "POST", "/v1/resume", { runId: approvalRunId, nodeId: "gate" });
await waitForRun(approvalRunId, ["succeeded"]);

// 3. Terminal failure + DLQ + replay claim.
const doomedStarted = await call("start-doomed", "POST", "/v1/start", { workflow: doomedWorkflow });
const doomedRunId = doomedStarted?.data?.runId ?? doomedStarted?.runId;
await waitForRun(doomedRunId, ["failed"]);
await call("status-failed", "GET", `/v1/status?runId=${doomedRunId}`);
await call("run-failed", "GET", `/v1/run?runId=${doomedRunId}`);
const dlq = await call("dlq-list", "GET", "/v1/dlq?limit=5");
const deadLetterId = (dlq?.data?.deadLetters ?? dlq?.deadLetters ?? dlq?.data?.items ?? [])[0]?.id;
if (deadLetterId) {
  await call("dlq-replay", "POST", "/v1/dlq/replay", { deadLetterId });
  await call("dlq-replay-conflict", "POST", "/v1/dlq/replay", { deadLetterId });
}

// 4. Error shapes.
await call("run-not-found", "GET", "/v1/run?runId=ghost-run-id");
await call("run-cross-org", "GET", `/v1/run?runId=${runId}`, undefined, { org: "other-org" });
await call("start-invalid", "POST", "/v1/start", { workflow: { nodes: "nope" } });
await call("resume-not-waiting", "POST", "/v1/resume", { runId, nodeId: "shape" });

await mkdir(OUT, { recursive: true });
for (const [name, record] of captures) {
  await writeFile(join(OUT, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
}
console.log(`captured ${captures.length} goldens into ${OUT}`);
