import http from "http";
import OpenAI from "openai";
import { ensureDatabaseSchema } from "@workflow-engine/db/src/schema-management";
import { startRun } from "@workflow-engine/engine/src/start-run";
import { resumeRun } from "@workflow-engine/engine/src/resume-run";
import { validateWorkflow } from "@workflow-engine/engine/src/workflow-validation";
import { listTools } from "@workflow-engine/engine/src/tool-registry";
import { getUsageSummary } from "@workflow-engine/engine/src/billing";
import { DLQReplayAdapter } from "@workflow-engine/engine/src/adapters/dlq-replay";
import { explainRun } from "@workflow-engine/ai";
import { replayDecision, type DecisionCandidate } from "@workflow-engine/domain";
import { requireAuth } from "./auth";
import { isRole, requireRole } from "./permissions";
import { workflowTemplates } from "./templates";
import { db } from "@workflow-engine/db";
import {
  workflows,
  workflowVersions,
  runs,
  runNodes,
  runEvents,
  credentials,
  installedPlugins,
  auditLogs,
  orgMembers,
} from "@workflow-engine/db";
import { eq, desc, asc, and, gt } from "drizzle-orm";
import { NodeSchema, WorkflowSchema } from "@workflow-engine/shared";
import {
  getDeadLetter,
  listDeadLetters,
  markDeadLetterReplayed,
  markDeadLetterResolved,
} from "./dlq";

const PORT = Number(process.env.PORT || 3001);
const MAX_JSON_BODY_BYTES = Number(process.env.API_MAX_JSON_BODY_BYTES || 1_048_576);
let openai: OpenAI | null = null;

type CorsAwareResponse = http.ServerResponse & { requestOrigin?: string };

const dlqReplay = new DLQReplayAdapter();

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function httpError(message: string, statusCode: number) {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = statusCode;
  return err;
}

function getAllowedOrigins() {
  const configured = process.env.API_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173";
  return configured.split(",").map(origin => origin.trim()).filter(Boolean);
}

function corsHeaders(res: http.ServerResponse) {
  const origin = (res as CorsAwareResponse).requestOrigin;
  const allowedOrigins = getAllowedOrigins();
  const allowAny = allowedOrigins.includes("*");
  const allowedOrigin = !origin
    ? "*"
    : allowAny || allowedOrigins.includes(origin)
      ? origin
      : "null";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-org-id, x-user-id",
    "Vary": "Origin",
  };
}

function sendJson(res: http.ServerResponse, payload: unknown, status = 200) {
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify({ error: "Failed to serialize response" });
    status = 500;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(res),
  });
  res.end(body);
}

function sendEvent(res: http.ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJson(req: http.IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let body = "";
    let receivedBytes = 0;
    let rejected = false;

    req.on("data", chunk => {
      receivedBytes += chunk.length;

      if (receivedBytes > MAX_JSON_BODY_BYTES) {
        rejected = true;
        reject(httpError(`Request body too large. Limit is ${MAX_JSON_BODY_BYTES} bytes`, 413));
        req.destroy();
        return;
      }

      body += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (rejected) return;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(httpError("Invalid JSON body", 400));
      }
    });
  });
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function decisionCandidatesFromPayload(payload: unknown): DecisionCandidate[] {
  const record = asRecord(payload);
  const ranking = Array.isArray(record.ranking) ? record.ranking : [];

  return ranking.flatMap(item => {
    const candidate = asRecord(item);
    const breakdown = asRecord(candidate.breakdown);
    const nodeId = typeof candidate.nodeId === "string" ? candidate.nodeId : "";
    if (!nodeId) return [];

    return [{
      nodeId,
      avgCost: asNumber(breakdown.cost),
      avgLatencyMs: asNumber(breakdown.latency),
      successRate: asNumber(breakdown.quality),
    }];
  });
}

async function audit(orgId: string, userId: string, action: string, targetType?: string, targetId?: string, metadata: unknown = {}) {
  try {
    await db.insert(auditLogs).values({ id: crypto.randomUUID(), orgId, userId, action, targetType, targetId, metadata });
  } catch (error) {
    console.warn("audit write failed", error);
  }
}

const server = http.createServer(async (req, res) => {
  (res as CorsAwareResponse).requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(res));
    return res.end();
  }

  try {
    if (req.method === "GET" && req.url === "/health") return sendJson(res, { ok: true });

    const auth = await requireAuth(req);

    if (req.method === "GET" && req.url === "/tools") return sendJson(res, listTools());
    if (req.method === "GET" && req.url === "/templates") return sendJson(res, workflowTemplates);
    if (req.method === "GET" && req.url === "/billing/usage") return sendJson(res, await getUsageSummary(auth.orgId));

    // Members / roles
    if (req.method === "GET" && req.url === "/members") {
      const rows = await db.select().from(orgMembers).where(eq(orgMembers.orgId, auth.orgId));
      return sendJson(res, rows);
    }

    if (req.method === "POST" && req.url === "/members/invite") {
      await requireRole(auth.orgId, auth.userId, "admin", auth.mode);
      const body = asRecord(await readJson(req));
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const role = isRole(body.role) ? body.role : "viewer";
      if (!email) return sendJson(res, { error: "email is required" }, 400);
      const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : email;
      const existing = await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      if (existing[0]) return sendJson(res, { error: "Member already exists for this org" }, 409);
      const id = crypto.randomUUID();
      await db.insert(orgMembers).values({ id, orgId: auth.orgId, userId, email, role, invitedBy: auth.userId });
      await audit(auth.orgId, auth.userId, "member.invited", "member", userId, { email, role });
      return sendJson(res, { id });
    }

    if (req.method === "POST" && req.url === "/members/role") {
      await requireRole(auth.orgId, auth.userId, "admin", auth.mode);
      const body = asRecord(await readJson(req));
      const userId = typeof body.userId === "string" ? body.userId : "";
      if (!userId) return sendJson(res, { error: "userId is required" }, 400);
      if (!isRole(body.role)) return sendJson(res, { error: "role must be viewer, editor, or admin" }, 400);
      await db.update(orgMembers).set({ role: body.role }).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      await audit(auth.orgId, auth.userId, "member.role.updated", "member", userId, { role: body.role });
      return sendJson(res, { ok: true });
    }

    if (req.method === "DELETE" && req.url?.startsWith("/members")) {
      await requireRole(auth.orgId, auth.userId, "admin", auth.mode);
      const url = new URL(req.url, "http://localhost");
      const userId = url.searchParams.get("userId");
      if (!userId) return sendJson(res, { error: "userId is required" }, 400);
      await db.delete(orgMembers).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      await audit(auth.orgId, auth.userId, "member.removed", "member", userId);
      return sendJson(res, { ok: true });
    }

    // Workflows
    if (req.method === "GET" && req.url === "/workflows") {
      const rows = await db.select().from(workflows).where(eq(workflows.orgId, auth.orgId)).orderBy(desc(workflows.createdAt));
      return sendJson(res, rows);
    }

    if (req.method === "GET" && req.url?.startsWith("/workflows/versions")) {
      const url = new URL(req.url, "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);
      const versions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      return sendJson(res, versions);
    }

    if (req.method === "GET" && req.url?.startsWith("/workflows/latest")) {
      const url = new URL(req.url, "http://localhost");
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return sendJson(res, { error: "workflowId is required" }, 400);
      const versions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      return sendJson(res, versions[0] ?? null);
    }

    if (req.method === "POST" && req.url === "/workflows/save") {
      await requireRole(auth.orgId, auth.userId, "editor", auth.mode);
      const workflow = asRecord(await readJson(req));
      const validation = validateWorkflow(workflow);
      if (!validation.valid) return sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
      const parsedWorkflow = WorkflowSchema.parse(workflow);
      const workflowId = parsedWorkflow.id ?? crypto.randomUUID();
      const existingVersions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      const nextVersion = (existingVersions[0]?.version ?? 0) + 1;
      const existingWorkflow = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)));
      const workflowName = parsedWorkflow.name ?? workflowId;
      if (existingWorkflow[0]) {
        if (existingWorkflow[0].name !== workflowName) {
          await db.update(workflows).set({ name: workflowName }).where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)));
        }
      } else {
        await db.insert(workflows).values({ id: workflowId, orgId: auth.orgId, name: workflowName, createdBy: auth.userId });
      }
      const versionId = crypto.randomUUID();
      await db.insert(workflowVersions).values({ id: versionId, orgId: auth.orgId, workflowId, version: nextVersion, dagJson: { ...parsedWorkflow, id: workflowId, name: workflowName }, createdBy: auth.userId });
      await audit(auth.orgId, auth.userId, "workflow.saved", "workflow", workflowId, { version: nextVersion });
      return sendJson(res, { workflowId, versionId, version: nextVersion });
    }

    // Plugins / credentials
    if (req.method === "GET" && req.url === "/plugins") {
      const installed = await db.select().from(installedPlugins).where(eq(installedPlugins.orgId, auth.orgId));
      return sendJson(res, { available: listTools(), installed });
    }

    if (req.method === "POST" && req.url === "/plugins/install") {
      await requireRole(auth.orgId, auth.userId, "admin", auth.mode);
      const body = asRecord(await readJson(req));
      const pluginId = typeof body.pluginId === "string" ? body.pluginId : "";
      if (!pluginId) return sendJson(res, { error: "pluginId is required" }, 400);
      const id = crypto.randomUUID();
      await db.insert(installedPlugins).values({ id, orgId: auth.orgId, pluginId, configJson: body.config ?? {}, installedBy: auth.userId });
      await audit(auth.orgId, auth.userId, "plugin.installed", "plugin", pluginId, body.config ?? {});
      return sendJson(res, { id });
    }

    if (req.method === "GET" && req.url === "/credentials") {
      const rows = await db.select().from(credentials).where(eq(credentials.orgId, auth.orgId));
      return sendJson(res, rows);
    }

    if (req.method === "POST" && req.url === "/credentials") {
      await requireRole(auth.orgId, auth.userId, "admin", auth.mode);
      const body = asRecord(await readJson(req));
      if (typeof body.name !== "string" || typeof body.kind !== "string" || typeof body.secretRef !== "string") {
        return sendJson(res, { error: "name, kind, and secretRef are required" }, 400);
      }
      const id = crypto.randomUUID();
      await db.insert(credentials).values({ id, orgId: auth.orgId, name: body.name, kind: body.kind, secretRef: body.secretRef, metadata: body.metadata ?? {}, createdBy: auth.userId });
      await audit(auth.orgId, auth.userId, "credential.created", "credential", id, { kind: body.kind });
      return sendJson(res, { id });
    }

    if (req.method === "GET" && req.url === "/audit") {
      const rows = await db.select().from(auditLogs).where(eq(auditLogs.orgId, auth.orgId)).orderBy(desc(auditLogs.createdAt));
      return sendJson(res, rows.slice(0, 100));
    }

    if (req.method === "POST" && req.url === "/validate") return sendJson(res, validateWorkflow(await readJson(req)));

    // AI helpers
    if (req.method === "POST" && req.url === "/ai/generate-workflow") {
      const { prompt } = asRecord(await readJson(req));
      const client = getOpenAIClient();
      if (!client) return sendJson(res, workflowTemplates[0]?.workflow ?? {});
      const response = await client.responses.create({
        model: "gpt-4o-mini",
        input: [
          {
            role: "system",
            content: "Generate only valid JSON for a workflow DAG. Shape: {dslVersion:'1.0',id,name,nodes:[{id,type,config}],edges:[{from,to,condition?}]}. Supported node types: http, tool, transform, condition, agent, multi_agent, agent_reflection, loop, ai, approval, webhook, noop.",
          },
          { role: "user", content: String(prompt ?? "") },
        ],
        text: { format: { type: "json_object" } },
      });
      try {
        return sendJson(res, JSON.parse(response.output_text || "{}"));
      } catch {
        return sendJson(res, { error: "AI returned invalid JSON" }, 502);
      }
    }

    if (req.method === "POST" && req.url === "/ai/explain-workflow") {
      const { workflow } = asRecord(await readJson(req));
      const client = getOpenAIClient();
      if (!client) return sendJson(res, { explanation: "This workflow contains nodes connected by edges and can be executed by the engine." });
      const response = await client.responses.create({ model: "gpt-4o-mini", input: `Explain this workflow clearly: ${JSON.stringify(workflow)}` });
      return sendJson(res, { explanation: response.output_text });
    }

    if (req.method === "POST" && req.url === "/ai/explain-run") {
      const { runId, question } = asRecord(await readJson(req));
      if (typeof runId !== "string") return sendJson(res, { error: "runId is required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Run not found" }, 404);

      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.createdAt));
      const result = await explainRun({
        openai: getOpenAIClient() ?? undefined,
        run: run[0],
        events,
        question: typeof question === "string" ? question : undefined,
      });

      return sendJson(res, result);
    }

    // Runs
    if (req.method === "GET" && req.url === "/runs") {
      const rows = await db.select().from(runs).where(eq(runs.orgId, auth.orgId)).orderBy(desc(runs.createdAt));
      return sendJson(res, rows);
    }

    if (req.method === "GET" && req.url?.startsWith("/run?")) {
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.createdAt));
      return sendJson(res, { run: run[0], nodes, events });
    }

    if (req.method === "GET" && req.url?.startsWith("/status")) {
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.createdAt));
      return sendJson(res, { run: run[0], nodes, events });
    }

    if (req.method === "GET" && req.url?.startsWith("/events")) {
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...corsHeaders(res) });
      let lastSeen: Date | null = null;
      const tick = async () => {
        const filter = lastSeen
          ? and(eq(runEvents.runId, runId), gt(runEvents.createdAt, lastSeen))
          : eq(runEvents.runId, runId);
        const events = await db.select().from(runEvents).where(filter).orderBy(asc(runEvents.createdAt));
        if (events.length) {
          lastSeen = events[events.length - 1].createdAt ?? lastSeen;
          sendEvent(res, events);
        }
      };
      const interval = setInterval(() => { void tick(); }, 1000);
      void tick();
      req.on("close", () => clearInterval(interval));
      return;
    }

    if (req.method === "POST" && req.url === "/start") {
      await requireRole(auth.orgId, auth.userId, "editor", auth.mode);
      const workflow = asRecord(await readJson(req));
      const validation = validateWorkflow(workflow);
      if (!validation.valid) return sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
      const parsedWorkflow = WorkflowSchema.parse(workflow);
      const result = await startRun({ ...parsedWorkflow, orgId: auth.orgId, createdBy: auth.userId });
      await audit(auth.orgId, auth.userId, "run.started", "run", result.runId, { workflowId: parsedWorkflow.id });
      return sendJson(res, result);
    }

    if (req.method === "POST" && req.url === "/resume") {
      await requireRole(auth.orgId, auth.userId, "editor", auth.mode);
      const { runId, nodeId } = asRecord(await readJson(req));
      if (typeof runId !== "string" || typeof nodeId !== "string") return sendJson(res, { error: "runId and nodeId are required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const result = await resumeRun(runId, nodeId);
      await audit(auth.orgId, auth.userId, "run.resumed", "run", runId, { nodeId });
      return sendJson(res, result);
    }

    if (req.method === "GET" && req.url?.startsWith("/causal")) {
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("runId");
      const nodeId = url.searchParams.get("nodeId");
      if (!runId || !nodeId) return sendJson(res, { error: "runId and nodeId are required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
      const decisionEvent = events.find(event => event.type === "decision.made" && event.nodeId === nodeId);
      if (!decisionEvent) return sendJson(res, { error: "No decision event" }, 404);

      const payload = asRecord(decisionEvent.payload);
      const result = replayDecision({
        chosenNodeId: typeof payload.chosenNodeId === "string" ? payload.chosenNodeId : undefined,
        candidates: decisionCandidatesFromPayload(payload),
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

      return sendJson(res, await listDeadLetters(auth.orgId, status));
    }

    if (req.method === "POST" && req.url === "/dlq/resolve") {
      await requireRole(auth.orgId, auth.userId, "editor", auth.mode);
      const { id } = asRecord(await readJson(req));
      if (typeof id !== "string") return sendJson(res, { error: "id is required" }, 400);

      await markDeadLetterResolved(auth.orgId, id);
      await audit(auth.orgId, auth.userId, "dlq.resolved", "dlq", id);

      return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && req.url === "/dlq/replay") {
      await requireRole(auth.orgId, auth.userId, "editor", auth.mode);
      const body = asRecord(await readJson(req));

      if (typeof body.deadLetterId === "string") {
        const item = await getDeadLetter(auth.orgId, body.deadLetterId);
        if (!item) return sendJson(res, { error: "Not found" }, 404);

        await dlqReplay.replayDeadLetter({
          runId: item.runId,
          workflow: WorkflowSchema.parse(item.workflowJson),
          node: NodeSchema.parse(item.nodeJson),
        });

        await markDeadLetterReplayed(auth.orgId, body.deadLetterId);
        await audit(auth.orgId, auth.userId, "dlq.replayed", "dlq", body.deadLetterId);

        return sendJson(res, { ok: true });
      }

      const { runId, nodeId } = body;
      if (typeof runId !== "string" || typeof nodeId !== "string") return sendJson(res, { error: "runId and nodeId are required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

      const version = await db.select().from(workflowVersions).where(eq(workflowVersions.id, run[0].workflowVersionId));
      if (!version[0] || version[0].orgId !== auth.orgId) return sendJson(res, { error: "Workflow version not found" }, 404);

      const workflow = WorkflowSchema.parse(version[0].dagJson);
      const node = workflow.nodes.find(candidate => candidate.id === nodeId);
      if (!node) return sendJson(res, { error: "Node not found in workflow" }, 404);

      await dlqReplay.replayDeadLetter({ runId, workflow, node });
      await audit(auth.orgId, auth.userId, "dlq.replayed", "run", runId, { nodeId });

      return sendJson(res, { ok: true });
    }

    return sendJson(res, { error: "Not found" }, 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const statusCode = err && typeof err === "object" && "statusCode" in err ? Number((err as { statusCode?: number }).statusCode) : 500;
    return sendJson(res, { error: message }, statusCode || 500);
  }
});

await ensureDatabaseSchema();

server.listen(PORT, () => console.log(`API running on port ${PORT}`));
