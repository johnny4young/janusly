// Generates the semantic-parity goldens by driving each fixture through the
// REFERENCE stack (API on :3001, dev-header auth, worker running,
// ALLOW_PRIVATE_HTTP_TARGETS=true so http fixtures can hit the local stub).
//
//   node go/conformance/gen-goldens.mjs
//
// Projection per run: final run status, per-node {status, attempts}, run
// outputJson, dead_letters row count for the run. Output:
// go/conformance/goldens/parity/<id>.json

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.GOLDENS_API_URL ?? "http://localhost:3001";
const ORG = "parity-org-" + Date.now().toString(36);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "goldens", "parity");

// ---- deterministic upstream stub -----------------------------------------
const healed = new Set();
const stub = createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (req.method === "POST" && path.startsWith("/heal")) {
    healed.add(path.replace("/heal", ""));
    res.writeHead(204).end();
    return;
  }
  if (path === "/ok") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ healed: true, source: "stub" }));
    return;
  }
  if (path === "/fail") {
    res.writeHead(500).end("boom");
    return;
  }
  if (path.startsWith("/flaky")) {
    if (healed.has(path)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ healed: true }));
    } else {
      res.writeHead(500).end("still down");
    }
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const upstream = `http://127.0.0.1:${stub.address().port}`;

// ---- reference API driver -------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", "x-org-id": ORG, "x-user-id": "parity" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function readRun(runId) {
  const res = await api("GET", `/run?runId=${runId}`);
  return res.body?.data ?? res.body;
}

async function waitFor(runId, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await readRun(runId);
    if (view && predicate(view)) return view;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`run ${runId}: condition never met`);
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

function projection(view, deadLetterCount) {
  const nodes = {};
  for (const node of view.nodes ?? []) {
    nodes[node.nodeId] = { status: node.status, attempts: node.attempts ?? 0 };
  }
  return {
    runStatus: view.run.status,
    nodes,
    outputJson: view.run.outputJson ?? null,
    deadLetters: deadLetterCount,
  };
}

// ---- fixture executor -----------------------------------------------------
const spec = JSON.parse(await readFile(join(HERE, "fixtures.json"), "utf8"));
await mkdir(OUT, { recursive: true });

// GOLDENS_ONLY=F11 recaptures a single fixture without touching the rest —
// the stack serving :3001 may have drifted from the pin the others used.
const only = process.env.GOLDENS_ONLY ? new Set(process.env.GOLDENS_ONLY.split(",")) : null;

for (const fixture of spec.fixtures) {
  if (only && !only.has(fixture.id)) continue;
  const runToken = Date.now().toString(36);
  const fill = (value) => JSON.parse(
    JSON.stringify(value).replaceAll("{{UPSTREAM}}", upstream).replaceAll("{{RUN}}", runToken),
  );
  const doc = fill(fixture.workflow);
  const docV2 = fixture.workflowV2 ? fill(fixture.workflowV2) : null;
  let runId = null;
  let deadLetterId = null;
  const savedVersions = [];
  const seenRuns = new Set();
  let rolloutId = null;

  const findDeadLetter = async () => {
    const dlq = await api("GET", "/v1/dlq?limit=50");
    const rows = dlq.body?.data ?? [];
    const row = rows.find((r) => r.runId === runId);
    if (!row) throw new Error(`${fixture.id}: no dead letter for run`);
    return row.id;
  };

  for (const step of fixture.steps) {
    const [verb, arg] = step.split(":");
    if (verb === "save") {
      const res = await api("POST", "/workflows/save", doc);
      if (res.status !== 200) throw new Error(`${fixture.id}: save ${JSON.stringify(res)}`);
      savedVersions.push(res.body?.versionId ?? res.body?.data?.versionId);
    } else if (verb === "ingest") {
      // The reference selects the workflow org-wide by endpoint key; the
      // fresh per-capture org guarantees a unique match.
      const res = await api("POST", "/triggers/webhook/ingest", fixture.ingest);
      runId = res.body?.runId ?? res.body?.data?.runId;
      if (!runId) throw new Error(`${fixture.id}: ingest failed ${JSON.stringify(res)}`);
    } else if (verb === "start") {
      const res = await api("POST", "/start", { workflow: doc, input: fixture.input });
      runId = res.body?.data?.runId ?? res.body?.runId;
      if (!runId) throw new Error(`${fixture.id}: start failed ${JSON.stringify(res)}`);
      seenRuns.add(runId);
    } else if (verb === "saveV2") {
      const res = await api("POST", "/workflows/save", docV2);
      if (res.status !== 200) throw new Error(`${fixture.id}: saveV2 ${JSON.stringify(res)}`);
      savedVersions.push(res.body?.versionId ?? res.body?.data?.versionId);
    } else if (verb === "validateFix") {
      deadLetterId = await findDeadLetter();
      const res = await api("POST", "/dlq/validate-fix", { deadLetterId, suggestedWorkflow: doc });
      runId = res.body?.runId ?? res.body?.data?.runId;
      if (!runId) throw new Error(`${fixture.id}: validateFix ${JSON.stringify(res)}`);
      seenRuns.add(runId);
    } else if (verb === "startExpectPaused") {
      // Mirror the Go harness: the trip may land post-commit; absorb a
      // raced start as one more streak failure and retry.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const res = await api("POST", "/start", { workflow: doc, input: fixture.input });
        const code = res.body?.code ?? res.body?.error?.code;
        if (res.status === 409 && code === "workflow_circuit_breaker_paused") break;
        const racedRun = res.body?.data?.runId ?? res.body?.runId;
        if (!racedRun) throw new Error(`${fixture.id}: expected breaker 409, got ${JSON.stringify(res)}`);
        seenRuns.add(racedRun);
        await waitFor(racedRun, (v) => TERMINAL.has(v.run.status));
        if (Date.now() > deadline) throw new Error(`${fixture.id}: breaker never tripped`);
        await new Promise((r) => setTimeout(r, 150));
      }
    } else if (verb === "ingestExpectBuffered") {
      const res = await api("POST", "/triggers/webhook/ingest", fixture.ingest);
      const buffered = res.body?.buffered ?? res.body?.data?.buffered;
      if (res.status !== 202 || buffered !== true) {
        throw new Error(`${fixture.id}: expected buffered 202, got ${JSON.stringify(res)}`);
      }
    } else if (verb === "resumeWorkflow") {
      const res = await api("POST", `/workflows/${doc.id}/resume`, {});
      if (res.status !== 200) throw new Error(`${fixture.id}: resumeWorkflow ${JSON.stringify(res)}`);
    } else if (verb === "adoptNewestRun") {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const res = await api("GET", "/runs?limit=50");
        const rows = res.body?.data ?? res.body ?? [];
        const fresh = rows.find((r) => r.workflowId === doc.id && !seenRuns.has(r.id));
        if (fresh) { runId = fresh.id; seenRuns.add(runId); break; }
        if (Date.now() > deadline) throw new Error(`${fixture.id}: backfilled run never appeared`);
        await new Promise((r) => setTimeout(r, 200));
      }
    } else if (verb === "waitRunWaiting") {
      await waitFor(runId, (v) => v.run.status === "waiting");
    } else if (verb === "rolloutCreate") {
      const res = await api("POST", `/workflows/${doc.id}/rollout`, {
        baselineVersionId: savedVersions[0], canaryVersionId: savedVersions[1],
        trafficPercent: 20, minimumSampleSize: 5, minimumSuccessRatePercent: 90,
      });
      rolloutId = res.body?.rollout?.id ?? res.body?.data?.rollout?.id;
      if (!rolloutId) throw new Error(`${fixture.id}: rolloutCreate ${JSON.stringify(res)}`);
    } else if (verb === "rolloutPromote" || verb === "rolloutRollback") {
      const decision = verb === "rolloutPromote" ? "promote" : "rollback";
      const res = await api("POST", `/workflows/${doc.id}/rollout/${rolloutId}/${decision}`, {});
      if (res.status !== 200) throw new Error(`${fixture.id}: ${verb} ${JSON.stringify(res)}`);
    } else if (verb === "clusterApplyFix") {
      deadLetterId = await findDeadLetter();
      const clusters = await api("GET", "/dlq/clusters");
      const signature = (clusters.body?.clusters ?? clusters.body?.data?.clusters ?? [])[0]?.signature;
      if (!signature) throw new Error(`${fixture.id}: no cluster signature`);
      const res = await api("POST", "/dlq/cluster-apply", {
        clusterSignature: signature, deadLetterIds: [deadLetterId], suggestedWorkflow: docV2,
      });
      const replayed = res.body?.replayed ?? res.body?.data?.replayed;
      if (replayed !== 1) throw new Error(`${fixture.id}: clusterApplyFix ${JSON.stringify(res)}`);
    } else if (verb === "cancel") {
      const res = await api("POST", "/run/cancel", { runId });
      if (res.status !== 200) throw new Error(`${fixture.id}: cancel ${JSON.stringify(res)}`);
    } else if (verb === "waitTerminal") {
      await waitFor(runId, (v) => TERMINAL.has(v.run.status));
    } else if (verb === "waitNodeWaiting") {
      await waitFor(runId, (v) => (v.nodes ?? []).some((n) => n.nodeId === arg && n.status === "waiting"));
    } else if (verb === "resume") {
      const res = await api("POST", "/resume", { runId, nodeId: arg });
      if (res.status !== 200) throw new Error(`${fixture.id}: resume ${JSON.stringify(res)}`);
    } else if (verb === "healUpstream") {
      await fetch(`${upstream}/heal/flaky-${fixture.id.toLowerCase()}`, { method: "POST" });
    } else if (verb === "redrive") {
      const dlq = await api("GET", "/v1/dlq?limit=20");
      const rows = dlq.body?.data ?? [];
      const row = rows.find((r) => r.runId === runId);
      if (!row) throw new Error(`${fixture.id}: no dead letter for run`);
      deadLetterId = row.id;
      const res = await api("POST", "/v1/dlq/replay", { deadLetterId });
      if (res.status !== 200) throw new Error(`${fixture.id}: replay ${JSON.stringify(res)}`);
    } else {
      throw new Error(`${fixture.id}: unknown step ${step}`);
    }
  }

  const view = await readRun(runId);
  const dlq = await api("GET", "/v1/dlq?limit=50");
  const deadLetters = (dlq.body?.data ?? []).filter((r) => r.runId === runId).length;
  const result = projection(view, deadLetters);
  await writeFile(join(OUT, `${fixture.id}.json`), JSON.stringify(result, null, 2) + "\n");
  console.log(fixture.id, "→", result.runStatus, "nodes:", Object.keys(result.nodes).length, "dlq:", result.deadLetters);
}

stub.close();
console.log("parity goldens written to", OUT);
