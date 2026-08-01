// Dual-run shadow comparator (T-184): drives an IDENTICAL deterministic
// request corpus at the pinned Node reference backend AND the Go pilot,
// normalizes both wires (ids / timestamps / request ids out), and reports
// any divergence. Zero unexpected diffs = the strangler proxy can move a
// route family without the web noticing.
//
// Run via the reference-stack orchestrator so the Node side is isolated:
//
//   node go/conformance/run-reference-stack.mjs node go/conformance/run-dual.mjs
//
// The orchestrator exports GOLDENS_API_URL (the Node API). This script
// boots the Go binary itself (pilot database, :4620) and tears it down.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");
const NODE_API = process.env.GOLDENS_API_URL ?? "http://localhost:3001";
const GO_API = "http://127.0.0.1:4620";
const DB = process.env.JANUSLY_GO_DATABASE_URL
  ?? "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

console.log("== build + boot go api on :4620 ==");
await run("go", ["build", "-o", "/tmp/janusly-go-dual-api", "./cmd/api"], { cwd: GO_DIR });
const goApi = spawn("/tmp/janusly-go-dual-api", [], {
  env: {
    ...process.env,
    JANUSLY_GO_DATABASE_URL: DB,
    JANUSLY_GO_PORT: "4620",
    JANUSLY_GO_INTERNAL_PORT: "4621",
    JANUSLY_GO_POLL_MS: "50",
    ALLOW_PRIVATE_HTTP_TARGETS: "true",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const stopGo = () => { try { goApi.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", stopGo);
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${GO_API}/healthz`)).ok) break;
  } catch { /* booting */ }
  if (i > 60) { stopGo(); throw new Error("go api never became healthy"); }
  await delay(250);
}

/* ------------------------------ normalization ----------------------------- */

// Keys whose VALUES vary run-to-run (ids, clocks, latencies) — replaced
// with a stable sentinel so the diff sees structure + semantics only.
const DYNAMIC_KEY = /(^id$|Id$|^requestId$|^runId$|At$|^createdAt$|^updatedAt$|^timestamp$|^expiresAt$|latency|durationMs$|^costUsd$|^token$|^resumeToken$|^cursor$|^nextCursor$|^eventsCursor$)/;
// Free-prose fields whose wording may legally differ while the CODE pins
// the contract (error `code` + status stay compared verbatim).
// `name` included: error-class taxonomy is runtime-specific (undici
// TypeError vs Go net errors) while code/status stay compared verbatim.
const PROSE_KEY = /^(message|description|hint|reason|title|error|name)$/;

function normalize(value, keyName = "") {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalize(item));
    if (value.every((item) => item && typeof item === "object" && typeof item.nodeId === "string")) {
      const order = value.map((item, index) => [item.nodeId, index]).sort((x, y) => x[0].localeCompare(y[0]));
      return order.map(([, index]) => items[index]);
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalize(value[key], key);
    return out;
  }
  if (typeof value === "string") {
    if (DYNAMIC_KEY.test(keyName)) return "<dyn>";
    if (PROSE_KEY.test(keyName)) return "<prose>";
    // Inline ISO timestamps / uuids inside otherwise-stable strings.
    return value
      .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z?/g, "<ts>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  }
  if (typeof value === "number" && DYNAMIC_KEY.test(keyName)) return "<dyn>";
  return value;
}

function diffPaths(a, b, path = "$", out = []) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${path}: array length ${a.length} vs ${b.length}`); return out; }
    a.forEach((item, index) => diffPaths(item, b[index], `${path}[${index}]`, out));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!(key in a)) out.push(`${path}.${key}: only in node`);
      else if (!(key in b)) out.push(`${path}.${key}: only in go`);
      else diffPaths(a[key], b[key], `${path}.${key}`, out);
    }
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return out;
}

/* ------------------------------ backend driver ---------------------------- */

class Backend {
  constructor(name, base) {
    this.name = name;
    this.base = base;
    this.org = `dual-${name}-${Date.now().toString(36)}`;
    this.vars = {};
  }
  async call(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: { "content-type": "application/json", "x-org-id": this.org, "x-user-id": "dual-user" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }
  async waitNodeWaiting(runId, nodeId, timeoutMs = 30_000) {
    // The reference keeps the RUN running while a node waits — the pause
    // is node-level on both backends, so the comparable signal is the
    // node status (same probe the golden capture uses).
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.call("GET", `/v1/run?runId=${runId}`);
      const nodes = res.body?.data?.nodes ?? [];
      if (nodes.some((n) => n.nodeId === nodeId && n.status === "waiting")) return;
      if (Date.now() > deadline) throw new Error(`${this.name}: node ${nodeId} of ${runId} never waited`);
      await delay(150);
    }
  }
  async waitRun(runId, want, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.call("GET", `/v1/status?runId=${runId}`);
      const status = res.body?.data?.run?.status ?? res.body?.data?.status;
      if (want.includes(status)) return status;
      if (Date.now() > deadline) throw new Error(`${this.name}: run ${runId} never reached ${want}`);
      await delay(150);
    }
  }
}

/* -------------------------------- corpus ---------------------------------- */

// workflows.id is a GLOBAL PK on the pilot's long-lived dev database, so
// every invocation mints fresh ids (identical across the two backends).
const STAMP = Date.now().toString(36);
const LINEAR_ID = `dual-linear-${STAMP}`;
const APPROVAL_ID = `dual-approval-${STAMP}`;
const FAILING_ID = `dual-failing-${STAMP}`;

const linear = {
  id: LINEAR_ID,
  name: "Dual linear",
  dslVersion: "1.0",
  nodes: [
    { id: "shape", type: "transform", config: { mapping: { verdict: "ok", total: 3 } } },
    { id: "done", type: "noop", config: {} },
  ],
  edges: [{ from: "shape", to: "done" }],
};
const approval = {
  id: APPROVAL_ID,
  name: "Dual approval",
  dslVersion: "1.0",
  nodes: [
    { id: "gate", type: "approval", config: { message: "Dual gate" } },
    { id: "after", type: "noop", config: {} },
  ],
  edges: [{ from: "gate", to: "after" }],
};
const failing = {
  id: FAILING_ID,
  name: "Dual failing",
  dslVersion: "1.0",
  nodes: [
    { id: "boom", type: "http", config: { url: "http://127.0.0.1:1/unreachable", retry: { maxAttempts: 1 } } },
  ],
  edges: [],
};

// Each case: name + (backend) => wire record. Cases run in order against
// each backend independently, so stateful ladders (save → start → status)
// stay comparable.
const CASES = [
  ["save-linear", (b) => b.call("POST", "/workflows/save", linear)],
  ["save-approval", (b) => b.call("POST", "/workflows/save", approval)],
  ["save-invalid-dag", (b) => b.call("POST", "/workflows/save", {
    ...linear, id: `dual-cycle-${STAMP}`, edges: [{ from: "shape", to: "done" }, { from: "done", to: "shape" }],
  })],
  ["validate", (b) => b.call("POST", "/validate", linear)],
  ["workflows-list", (b) => b.call("GET", "/v1/workflows?limit=5")],
  ["workflow-latest", (b) => b.call("GET", `/v1/workflows/latest?workflowId=${LINEAR_ID}`)],
  ["workflow-versions", (b) => b.call("GET", `/v1/workflows/versions?workflowId=${LINEAR_ID}`)],
  ["start-linear", async (b) => {
    const res = await b.call("POST", "/start", { workflow: linear });
    b.vars.linearRun = res.body?.runId;
    await b.waitRun(b.vars.linearRun, ["succeeded"]);
    return res;
  }],
  ["status-linear", (b) => b.call("GET", `/v1/status?runId=${b.vars.linearRun}`)],
  ["run-linear", (b) => b.call("GET", `/v1/run?runId=${b.vars.linearRun}`)],
  ["runs-list", (b) => b.call("GET", "/v1/runs?limit=5")],
  ["run-unknown", (b) => b.call("GET", "/v1/run?runId=ghost")],
  ["start-approval", async (b) => {
    const res = await b.call("POST", "/start", { workflow: approval });
    b.vars.approvalRun = res.body?.runId;
    await b.waitNodeWaiting(b.vars.approvalRun, "gate");
    return res;
  }],
  ["resume-approval", async (b) => {
    const res = await b.call("POST", "/resume", { runId: b.vars.approvalRun, nodeId: "gate" });
    await b.waitRun(b.vars.approvalRun, ["succeeded"]);
    return res;
  }],
  ["cancel-terminal", (b) => b.call("POST", "/run/cancel", { runId: b.vars.linearRun })],
  ["start-failing", async (b) => {
    const res = await b.call("POST", "/start", { workflow: failing });
    b.vars.failingRun = res.body?.runId;
    await b.waitRun(b.vars.failingRun, ["failed"]);
    return res;
  }],
  ["dlq-list", async (b) => {
    // The dead letter lands post-terminal; settle briefly.
    await delay(500);
    return b.call("GET", "/v1/dlq");
  }],
  ["dlq-counts", (b) => b.call("GET", "/dlq/counts")],
  ["workflow-delete", (b) => b.call("DELETE", `/workflows/${LINEAR_ID}`)],
  ["workflow-trash", (b) => b.call("GET", "/workflows/trash")],
  ["workflow-restore", (b) => b.call("POST", `/workflows/${LINEAR_ID}/restore`, {})],
  ["org-config", (b) => b.call("GET", "/org/config")],
  ["org-config-write", (b) => b.call("POST", "/org/config", { key: "ai.maxOutputUnits", value: 900 })],
  ["tools-catalog-v1", async (b) => {
    const res = await b.call("GET", "/v1/tools");
    // Compare only the shared tool NAMES + field grammar for the overlap:
    // catalog SIZE legitimately differs while integrations land in waves.
    const tools = res.body?.data ?? [];
    return { status: res.status, body: { names: tools.map((t) => t.name).filter((n) => ["http.request", "json.parse", "text.uppercase"].includes(n)).sort() } };
  }],
  ["auth-context-keys", async (b) => {
    const res = await b.call("GET", "/auth/context");
    return { status: res.status, body: { keys: Object.keys(res.body ?? {}).sort(), mode: res.body?.mode } };
  }],
  ["members-list", (b) => b.call("GET", "/members")],
  ["invite-invalid-email", (b) => b.call("POST", "/members/invite", { email: "not-an-email", role: "viewer" })],
];

/* --------------------------------- run ------------------------------------ */

// Documented divergences (CUTOVER-MAP.md "Divergencias con destino"):
// a diff whose path starts with one of these prefixes reports as EXPECTED
// and does not fail the run. Keep this list SHORT and justified.
const EXPECTED_DIVERGENCES = {
  "status-linear": [
    ["$.body.data.run.traceId", "OTel trace id no poblado en el pilot (destino: T-504)"],
  ],
  "run-linear": [
    ["$.body.data.run.traceId", "OTel trace id (destino: T-504)"],
  ],
  "runs-list": [["$.body.data[0].traceId", "OTel trace id"]],
  "org-config": [
    ["$.body.config[16].source", "artefacto del reference: applyOrgConfigToEnv muta process.env y las claves http.*/subworkflow.maxDepth se auto-reportan 'env' (el 'default' del pilot es el honesto)"],
    ["$.body.config[17].source", "mismo artefacto de overlay env"],
    ["$.body.config[18].source", "mismo artefacto de overlay env"],
    ["$.body.config[24].source", "mismo artefacto de overlay env"],
  ],
};

function classifyDiffs(name, diffs) {
  const expected = [];
  const unexpectedDiffs = [];
  for (const diff of diffs) {
    const rule = (EXPECTED_DIVERGENCES[name] ?? []).find(([prefix]) => diff.startsWith(prefix));
    if (rule) expected.push(`${diff}  [expected: ${rule[1]}]`);
    else unexpectedDiffs.push(diff);
  }
  return { expected, unexpectedDiffs };
}

const nodeBackend = new Backend("node", NODE_API);
const goBackend = new Backend("go", GO_API);
const report = [];
let unexpected = 0;

try {
  for (const [name, exec] of CASES) {
    const [nodeRes, goRes] = [await exec(nodeBackend), await exec(goBackend)];
    const nodeNorm = normalize(nodeRes);
    const goNorm = normalize(goRes);
    const diffs = diffPaths(goNorm, nodeNorm);
    const { expected, unexpectedDiffs } = classifyDiffs(name, diffs);
    if (unexpectedDiffs.length === 0 && expected.length === 0) {
      report.push(`OK   ${name}`);
    } else if (unexpectedDiffs.length === 0) {
      report.push(`OK*  ${name} (${expected.length} expected divergence(s))`);
    } else {
      unexpected += 1;
      report.push(`DIFF ${name}\n  ${unexpectedDiffs.slice(0, 12).join("\n  ")}`);
    }
    if ((process.env.DUAL_DUMP ?? "").split(",").includes(name)) {
      console.log(`---- dump ${name} (go) ----\n${JSON.stringify(goRes, null, 1)}`);
      console.log(`---- dump ${name} (node) ----\n${JSON.stringify(nodeRes, null, 1)}`);
    }
  }
} finally {
  stopGo();
}

console.log("\n== dual-run report ==");
for (const line of report) console.log(line);
console.log(`\n${CASES.length - unexpected}/${CASES.length} identical after normalization`);
if (unexpected > 0) {
  console.error(`\n${unexpected} unexpected divergence(s)`);
  process.exit(1);
}
console.log("== dual-run green ==");
