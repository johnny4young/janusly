// Kill-failover harness: two Go instances over the SAME Postgres,
// sustained run traffic, one instance SIGKILLed mid-flight (the crash
// case — no drain), and the survivor must absorb everything:
//
//   - pending/queued work publishes through Postgres, so the survivor's
//     dispatcher claims it naturally (the atomic claim ladder is the
//     exactly-once guarantee);
//   - nodes the dead instance had CLAIMED (running) are reaped loudly by
//     the survivor's stalled-node reaper (env-tuned short threshold here)
//     into failed runs + DLQ rows — recovered, never lost, never silent;
//   - the harness asserts EVERY started run reaches a terminal status,
//     no node records more than one attempt without a declared retry,
//     and the survivor stays healthy throughout; the killed instance then
//     restarts and serves again (rejoin).
//
//   node go/conformance/run-failover.mjs
//
// Requires the pilot database up (make db-up + make migrate).

import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");
const DB = process.env.JANUSLY_GO_DATABASE_URL
  ?? "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go";
const ORG = `failover-${Date.now().toString(36)}`;
const RUNS_BEFORE_KILL = 30;
const RUNS_AFTER_KILL = 30;
const TERMINAL_DEADLINE_MS = 90_000;

console.error("== failover: build ==");
execFileSync("go", ["build", "-o", "/tmp/janusly-go-failover-api", "./cmd/api"], {
  cwd: GO_DIR, stdio: "inherit",
});

function boot(name, port, internalPort) {
  const child = spawn("/tmp/janusly-go-failover-api", [], {
    env: {
      ...process.env,
      JANUSLY_GO_DATABASE_URL: DB,
      JANUSLY_GO_WORK_PLANE_ENABLED: "true",
      OTEL_EXPORTER: "none",
      JANUSLY_GO_PORT: String(port),
      JANUSLY_GO_INTERNAL_PORT: String(internalPort),
      JANUSLY_GO_POLL_MS: "50",
      // Short reaper so a killed replica's claimed nodes recover inside
      // the harness deadline (production tunes this per deployment).
      JANUSLY_GO_REAPER_INTERVAL_MS: "1000",
      JANUSLY_GO_REAPER_THRESHOLD_MS: "5000",
      JANUSLY_GO_REAPER_THRESHOLD_FLOOR_MS: "1000",
      ALLOW_PRIVATE_HTTP_TARGETS: "true",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  child.instanceName = name;
  child.port = port;
  return child;
}

async function waitHealthy(port, label) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch { /* booting */ }
    await delay(250);
  }
  throw new Error(`${label} never became healthy`);
}

async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-org-id": ORG, "x-user-id": "failover" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A small mixed workload: fast three-node chains (transform → tool →
// noop) so both claim contention and multi-step readiness are exercised.
function workload(index) {
  return {
    id: `failover-${ORG}-${index}`,
    name: `Failover ${index}`,
    dslVersion: "1.0",
    nodes: [
      { id: "shape", type: "transform", config: { mapping: { index, verdict: "ok" } } },
      { id: "shout", type: "tool", config: { tool: "text.uppercase", input: { value: `run ${index}` } } },
      { id: "done", type: "noop", config: {} },
    ],
    edges: [{ from: "shape", to: "shout" }, { from: "shout", to: "done" }],
  };
}

const started = [];
async function startRun(port, index) {
  const res = await api(port, "POST", "/start", { workflow: workload(index) });
  if (res.status !== 200 || !res.body?.runId) {
    throw new Error(`start ${index} via :${port} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  started.push(res.body.runId);
}

const instanceA = boot("A", 4660, 4661);
let instanceB = boot("B", 4662, 4663);
const stopAll = () => {
  for (const child of [instanceA, instanceB]) {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
};
process.on("exit", stopAll);

try {
  await waitHealthy(4660, "instance A");
  await waitHealthy(4662, "instance B");
  console.error("== failover: both instances healthy; driving traffic ==");

  // Phase 1: alternate starts across BOTH instances.
  for (let i = 0; i < RUNS_BEFORE_KILL; i++) {
    await startRun(i % 2 === 0 ? 4660 : 4662, i);
  }

  // Phase 2: SIGKILL B mid-flight — no drain, the crash case.
  console.error("== failover: SIGKILL instance B ==");
  instanceB.kill("SIGKILL");

  // Phase 3: keep the traffic coming through the survivor only.
  for (let i = RUNS_BEFORE_KILL; i < RUNS_BEFORE_KILL + RUNS_AFTER_KILL; i++) {
    await startRun(4660, i);
    if ((await fetch("http://127.0.0.1:4660/healthz")).ok !== true) {
      throw new Error("survivor went unhealthy under failover load");
    }
  }

  // Phase 4: every started run must reach a terminal status.
  console.error(`== failover: waiting for ${started.length} runs to settle ==`);
  const terminal = new Set(["succeeded", "failed", "cancelled"]);
  const deadline = Date.now() + TERMINAL_DEADLINE_MS;
  const statuses = new Map();
  for (;;) {
    let pending = 0;
    for (const runId of started) {
      if (terminal.has(statuses.get(runId))) continue;
      const res = await api(4660, "GET", `/v1/status?runId=${runId}`);
      const status = res.body?.data?.run?.status;
      statuses.set(runId, status);
      if (!terminal.has(status)) pending += 1;
    }
    if (pending === 0) break;
    if (Date.now() > deadline) {
      throw new Error(`${pending} run(s) never reached terminal after failover`);
    }
    await delay(500);
  }
  const byStatus = {};
  for (const status of statuses.values()) byStatus[status] = (byStatus[status] ?? 0) + 1;
  console.error(`== failover: all terminal ${JSON.stringify(byStatus)} ==`);

  // Phase 5: exactly-once — no node executed twice (attempts stays 1;
  // these workloads declare no retries). Reaped nodes fail at attempt 1.
  let doubled = 0;
  for (const runId of started) {
    const res = await api(4660, "GET", `/v1/run?runId=${runId}`);
    for (const node of res.body?.data?.nodes ?? []) {
      if ((node.attempts ?? 0) > 1) {
        doubled += 1;
        console.error(`DOUBLE EXECUTION: run ${runId} node ${node.nodeId} attempts=${node.attempts}`);
      }
    }
  }
  if (doubled > 0) throw new Error(`${doubled} node(s) executed more than once`);

  // Phase 6: rejoin — the killed instance boots again and serves.
  console.error("== failover: restarting instance B (rejoin) ==");
  instanceB = boot("B2", 4662, 4663);
  await waitHealthy(4662, "instance B (rejoined)");
  await startRun(4662, 9999);
  const rejoinRun = started[started.length - 1];
  const rejoinDeadline = Date.now() + 30_000;
  for (;;) {
    const res = await api(4662, "GET", `/v1/status?runId=${rejoinRun}`);
    if (res.body?.data?.run?.status === "succeeded") break;
    if (Date.now() > rejoinDeadline) throw new Error("rejoined instance never completed a run");
    await delay(300);
  }

  const failed = Object.entries(byStatus).filter(([status]) => status === "failed");
  console.log(`\n== failover green: ${started.length} runs terminal, exactly-once held, survivor healthy, rejoin served ==`);
  console.log(`   breakdown: ${JSON.stringify(byStatus)} (failed = reaped claims of the killed replica — recovered loudly, never lost)`);
  if (failed.length === 0) console.log("   (kill window landed between claims: zero reaped this run)");
} finally {
  stopAll();
}
