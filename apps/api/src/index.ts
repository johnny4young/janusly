// (only showing inserted routes section for brevity)

import { listDeadLetters, getDeadLetter, markDeadLetterReplayed, markDeadLetterResolved } from "./dlq";

// --- ADD BELOW OTHER ROUTES ---

if (req.method === "POST" && req.url === "/ai/explain-run") {
  const { runId, question } = asRecord(await readJson(req));

  if (typeof runId !== "string") return sendJson(res, { error: "runId is required" }, 400);

  const run = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Run not found" }, 404);

  const events = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId));

  const { explainRun } = await import("@workflow-engine/ai/src/runExplainer");

  const result = await explainRun({
    run: run[0],
    events,
    question: typeof question === "string" ? question : undefined,
  });

  return sendJson(res, result);
}

if (req.method === "GET" && req.url?.startsWith("/causal")) {
  const url = new URL(req.url, "http://localhost");
  const runId = url.searchParams.get("runId");
  const nodeId = url.searchParams.get("nodeId");

  if (!runId || !nodeId) return sendJson(res, { error: "runId and nodeId are required" }, 400);

  const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
  const decisionEvent = events.find((event) => event.type === "decision.made" && event.nodeId === nodeId);

  if (!decisionEvent) return sendJson(res, { error: "No decision event" }, 404);

  const { replayDecision } = await import("@workflow-engine/domain/src/causalReasoning");
  const payload = decisionEvent.payload as any;

  const result = replayDecision({
    chosenNodeId: payload?.chosenNodeId,
    candidates: (payload?.ranking ?? []).map((candidate: any) => ({
      nodeId: candidate.nodeId,
      avgCost: candidate.breakdown?.cost,
      avgLatencyMs: candidate.breakdown?.latency,
      successRate: candidate.breakdown?.quality,
    })),
    strategy: "auto",
  });

  return sendJson(res, result);
}

if (req.method === "GET" && req.url?.startsWith("/dlq")) {
  const url = new URL(req.url, "http://localhost");
  const id = url.searchParams.get("id");
  const status = url.searchParams.get("status");

  if (id) {
    const item = await getDeadLetter(auth.orgId, id);
    if (!item) return sendJson(res, { error: "Not found" }, 404);
    return sendJson(res, item);
  }

  const items = await listDeadLetters(auth.orgId, status);
  return sendJson(res, items);
}

if (req.method === "POST" && req.url === "/dlq/resolve") {
  await requireRole(auth.orgId, auth.userId, "editor", auth.mode);
  const { id } = asRecord(await readJson(req));
  if (typeof id !== "string") return sendJson(res, { error: "id is required" }, 400);

  await markDeadLetterResolved(auth.orgId, id);
  await audit(auth.orgId, auth.userId, "dlq.resolved", "dlq", id);

  return sendJson(res, { ok: true });
}

// Extend replay
if (req.method === "POST" && req.url === "/dlq/replay") {
  await requireRole(auth.orgId, auth.userId, "editor", auth.mode);
  const body = asRecord(await readJson(req));

  if (typeof body.deadLetterId === "string") {
    const item = await getDeadLetter(auth.orgId, body.deadLetterId);
    if (!item) return sendJson(res, { error: "Not found" }, 404);

    await dlqReplay.replayDeadLetter({
      runId: item.runId,
      workflow: item.workflowJson,
      node: item.nodeJson,
    } as any);

    await markDeadLetterReplayed(auth.orgId, body.deadLetterId);
    await audit(auth.orgId, auth.userId, "dlq.replayed", "dlq", body.deadLetterId);

    return sendJson(res, { ok: true });
  }

  // fallback to old behavior
  const { runId, nodeId } = body;
  if (typeof runId !== "string" || typeof nodeId !== "string") return sendJson(res, { error: "runId and nodeId are required" }, 400);

  const run = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

  const version = await db.select().from(workflowVersions).where(eq(workflowVersions.id, run[0].workflowVersionId));
  if (!version[0] || version[0].orgId !== auth.orgId) return sendJson(res, { error: "Workflow version not found" }, 404);

  const workflow = WorkflowSchema.parse(version[0].dagJson);
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return sendJson(res, { error: "Node not found in workflow" }, 404);

  await dlqReplay.replayDeadLetter({ runId, workflow, node });
  await audit(auth.orgId, auth.userId, "dlq.replayed", "run", runId, { nodeId });

  return sendJson(res, { ok: true });
}
