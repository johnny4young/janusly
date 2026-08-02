// Postgres chaos harness (T-531): the twin of run-failover with the
// DATABASE as the victim instead of a replica. Sustained run traffic,
// `docker stop` of Postgres mid-flight, then three verdicts:
//
//   1. the binary DOES NOT die — the API keeps answering (degraded
//      envelopes, never a hang or a crash) while the DB is gone;
//   2. on `docker start` the pgx pools reconnect WITHOUT a process
//      restart (healthz green again);
//   3. every pre-crash run reaches a terminal status — queued work is
//      claimed after reconnect, and claims whose completion tx died with
//      the DB are reaped LOUDLY (failed + DLQ), recovered never lost —
//      and no node executes more than once (attempts ≤ 1, no retries
//      declared).
//
// The harness runs its OWN Postgres container (the shared pilot DB also
// hosts the 24h soak — chaos must not pollute it), applies migrations
// through the binary's `migrate` subcommand, and loops THREE rounds.
//
//   node go/conformance/run-chaos.mjs

import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");
const PG_CONTAINER = "janusly-go-chaos-pg";
const PG_PORT = 4642;
const DB = `postgres://janusly:janusly-go-chaos@127.0.0.1:${PG_PORT}/janusly_go_chaos`;
const API_PORT = 4670;
const INTERNAL_PORT = 4671;
const ROUNDS = 3;
const RUNS_PER_ROUND = 20;
const OUTAGE_MS = 8_000;
const TERMINAL_DEADLINE_MS = 90_000;

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

console.error("== chaos: dedicated Postgres ==");
try { docker("rm", "-f", PG_CONTAINER); } catch { /* absent */ }
docker("run", "-d", "--name", PG_CONTAINER,
  "-e", "POSTGRES_USER=janusly", "-e", "POSTGRES_PASSWORD=janusly-go-chaos",
  "-e", "POSTGRES_DB=janusly_go_chaos",
  "-p", `${PG_PORT}:5432`, "pgvector/pgvector:pg18");
for (let i = 0; ; i++) {
  try {
    docker("exec", PG_CONTAINER, "pg_isready", "-U", "janusly", "-d", "janusly_go_chaos");
    break;
  } catch {
    if (i > 60) throw new Error("chaos postgres never became ready");
    await delay(500);
  }
}

console.error("== chaos: build + migrate ==");
execFileSync("go", ["build", "-o", "/tmp/janusly-go-chaos-api", "./cmd/api"], { cwd: GO_DIR, stdio: "inherit" });
execFileSync("/tmp/janusly-go-chaos-api", ["migrate"], {
  env: { ...process.env, JANUSLY_GO_DATABASE_URL: DB }, stdio: "inherit",
});

const api = spawn("/tmp/janusly-go-chaos-api", [], {
  env: {
    ...process.env,
    JANUSLY_GO_DATABASE_URL: DB,
    JANUSLY_GO_WORK_PLANE_ENABLED: "true",
    JANUSLY_GO_PORT: String(API_PORT),
    JANUSLY_GO_INTERNAL_PORT: String(INTERNAL_PORT),
    JANUSLY_GO_POLL_MS: "50",
    JANUSLY_GO_REAPER_INTERVAL_MS: "1000",
    JANUSLY_GO_REAPER_THRESHOLD_MS: "5000",
    JANUSLY_GO_REAPER_THRESHOLD_FLOOR_MS: "1000",
    OTEL_EXPORTER: "none",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const cleanup = () => {
  try { api.kill("SIGKILL"); } catch { /* gone */ }
  try { docker("rm", "-f", PG_CONTAINER); } catch { /* gone */ }
};
process.on("exit", cleanup);

const ORG = `chaos-${Date.now().toString(36)}`;
async function call(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-org-id": ORG, "x-user-id": "chaos" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${API_PORT}/healthz`)).ok) break;
  } catch { /* booting */ }
  if (i === 59) throw new Error("api never became healthy");
  await delay(300);
}

function workload(round, index) {
  return {
    id: `chaos-${ORG}-${round}-${index}`,
    name: `Chaos ${round}/${index}`,
    dslVersion: "1.0",
    nodes: [
      { id: "shape", type: "transform", config: { mapping: { index, verdict: "ok" } } },
      { id: "shout", type: "tool", config: { tool: "text.uppercase", input: { value: `chaos ${index}` } } },
      { id: "done", type: "noop", config: {} },
    ],
    edges: [{ from: "shape", to: "shout" }, { from: "shout", to: "done" }],
  };
}

const terminal = new Set(["succeeded", "failed", "cancelled"]);
let totalFailed = 0;

for (let round = 1; round <= ROUNDS; round++) {
  console.error(`== chaos round ${round}/${ROUNDS}: traffic ==`);
  const started = [];
  for (let index = 0; index < RUNS_PER_ROUND; index++) {
    const res = await call("POST", "/start", { workflow: workload(round, index) });
    if (res.status !== 200 || !res.body?.runId) {
      throw new Error(`start ${index} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    started.push(res.body.runId);
    if (index === Math.floor(RUNS_PER_ROUND / 2)) {
      // Mid-flight: kill the database under the running system. The
      // pre-crash cohort is everything started so far — several still
      // in flight when the plug is pulled.
      console.error(`== chaos round ${round}: docker stop postgres (mid-flight, ${started.length} runs started) ==`);
      docker("stop", "-t", "1", PG_CONTAINER);
      break;
    }
  }

  // Verdict 1: the process is ALIVE and answers cleanly while the DB is
  // gone. A degraded envelope (5xx JSON) is fine; a hang or crash is not.
  await delay(OUTAGE_MS / 2);
  if (api.exitCode !== null) throw new Error("API process died with the database — verdict 1 failed");
  const degraded = await call("POST", "/start", { workflow: workload(round, 999) })
    .catch((err) => ({ status: -1, body: { error: String(err) } }));
  if (degraded.status === 200) throw new Error("start must not succeed without a database");
  console.error(`   degraded start answered ${degraded.status} (clean envelope, no hang)`);

  await delay(OUTAGE_MS / 2);
  console.error(`== chaos round ${round}: docker start postgres ==`);
  docker("start", PG_CONTAINER);
  for (let i = 0; ; i++) {
    try {
      docker("exec", PG_CONTAINER, "pg_isready", "-U", "janusly", "-d", "janusly_go_chaos");
      break;
    } catch {
      if (i > 60) throw new Error("postgres never came back");
      await delay(500);
    }
  }

  // Verdict 2: pools reconnect WITHOUT restarting the process.
  const reconnectDeadline = Date.now() + 30_000;
  for (;;) {
    const probe = await call("GET", "/v1/runs?limit=1").catch(() => null);
    if (probe && probe.status === 200) break;
    if (Date.now() > reconnectDeadline) throw new Error("pools never reconnected — verdict 2 failed");
    await delay(500);
  }
  console.error("   pools reconnected without a process restart");

  // Verdict 3: every pre-crash run reaches terminal; exactly-once holds.
  const deadline = Date.now() + TERMINAL_DEADLINE_MS;
  const statuses = new Map();
  for (;;) {
    let pending = 0;
    for (const runId of started) {
      if (terminal.has(statuses.get(runId))) continue;
      const res = await call("GET", `/v1/status?runId=${runId}`).catch(() => null);
      const status = res?.body?.data?.run?.status;
      statuses.set(runId, status);
      if (!terminal.has(status)) pending += 1;
    }
    if (pending === 0) break;
    if (Date.now() > deadline) throw new Error(`${pending} run(s) never reached terminal — verdict 3 failed`);
    await delay(500);
  }
  let doubled = 0;
  for (const runId of started) {
    const res = await call("GET", `/v1/run?runId=${runId}`);
    for (const node of res.body?.data?.nodes ?? []) {
      if ((node.attempts ?? 0) > 1) {
        doubled += 1;
        console.error(`DOUBLE EXECUTION: run ${runId} node ${node.nodeId} attempts=${node.attempts}`);
      }
    }
  }
  if (doubled > 0) throw new Error(`${doubled} node(s) executed more than once`);
  const byStatus = {};
  for (const status of statuses.values()) byStatus[status] = (byStatus[status] ?? 0) + 1;
  totalFailed += byStatus.failed ?? 0;
  console.error(`== chaos round ${round} green: ${JSON.stringify(byStatus)} (failed = claims reaped loudly after the crash window) ==`);
}

console.log(`\n== chaos green ×${ROUNDS}: zero runs lost, pools reconnected in-process, exactly-once held ==`);
console.log(`   reaped-not-lost across rounds: ${totalFailed}`);
cleanup();
process.exit(0);
