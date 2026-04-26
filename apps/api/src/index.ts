import http from "http";
import OpenAI from "openai";
import { startRun, resumeRun, validateWorkflow, listTools, getUsageSummary } from "@workflow-engine/engine";
import { requireAuth } from "./auth";
import { requireRole } from "./permissions";
import { workflowTemplates } from "./templates";
import { db } from "@workflow-engine/db";
import { workflows, workflowVersions, runs, runNodes, runEvents, credentials, installedPlugins, auditLogs, orgMembers } from "@workflow-engine/db";
import { eq, desc, and } from "drizzle-orm";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = Number(process.env.PORT || 3001);

function sendJson(res: http.ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-org-id, x-user-id",
  });
  res.end(JSON.stringify(payload));
}

function sendEvent(res: http.ServerResponse, data: any) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJson(req: http.IncomingMessage) {
  return new Promise<any>((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
}

async function audit(orgId: string, userId: string, action: string, targetType?: string, targetId?: string, metadata: any = {}) {
  try {
    await db.insert(auditLogs).values({ id: crypto.randomUUID(), orgId, userId, action, targetType, targetId, metadata });
  } catch {}
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, {});

  try {
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
      await requireRole(auth.orgId, auth.userId, "admin");
      const body = await readJson(req);
      const id = crypto.randomUUID();
      await db.insert(orgMembers).values({ id, orgId: auth.orgId, userId: body.userId || body.email, email: body.email, role: body.role || "viewer", invitedBy: auth.userId });
      await audit(auth.orgId, auth.userId, "member.invited", "member", body.userId || body.email, { email: body.email, role: body.role || "viewer" });
      return sendJson(res, { id });
    }

    if (req.method === "POST" && req.url === "/members/role") {
      await requireRole(auth.orgId, auth.userId, "admin");
      const body = await readJson(req);
      await db.update(orgMembers).set({ role: body.role }).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, body.userId)));
      await audit(auth.orgId, auth.userId, "member.role.updated", "member", body.userId, { role: body.role });
      return sendJson(res, { ok: true });
    }

    if (req.method === "DELETE" && req.url?.startsWith("/members")) {
      await requireRole(auth.orgId, auth.userId, "admin");
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
      const workflowId = url.searchParams.get("workflowId") ?? "ui-test";
      const versions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      return sendJson(res, versions[0] ?? null);
    }

    if (req.method === "POST" && req.url === "/workflows/save") {
      await requireRole(auth.orgId, auth.userId, "editor");
      const workflow = await readJson(req);
      const validation = validateWorkflow(workflow);
      if (!validation.valid) return sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
      const workflowId = workflow.id ?? crypto.randomUUID();
      const existingVersions = await db.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId))).orderBy(desc(workflowVersions.version));
      const nextVersion = (existingVersions[0]?.version ?? 0) + 1;
      const existingWorkflow = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId)));
      if (!existingWorkflow[0]) await db.insert(workflows).values({ id: workflowId, orgId: auth.orgId, name: workflow.name ?? workflowId, createdBy: auth.userId });
      const versionId = crypto.randomUUID();
      await db.insert(workflowVersions).values({ id: versionId, orgId: auth.orgId, workflowId, version: nextVersion, dagJson: { ...workflow, id: workflowId }, createdBy: auth.userId });
      await audit(auth.orgId, auth.userId, "workflow.saved", "workflow", workflowId, { version: nextVersion });
      return sendJson(res, { workflowId, versionId, version: nextVersion });
    }

    // Plugins / credentials
    if (req.method === "GET" && req.url === "/plugins") {
      const installed = await db.select().from(installedPlugins).where(eq(installedPlugins.orgId, auth.orgId));
      return sendJson(res, { available: listTools(), installed });
    }

    if (req.method === "POST" && req.url === "/plugins/install") {
      await requireRole(auth.orgId, auth.userId, "admin");
      const body = await readJson(req);
      const id = crypto.randomUUID();
      await db.insert(installedPlugins).values({ id, orgId: auth.orgId, pluginId: body.pluginId, configJson: body.config ?? {}, installedBy: auth.userId });
      await audit(auth.orgId, auth.userId, "plugin.installed", "plugin", body.pluginId, body.config ?? {});
      return sendJson(res, { id });
    }

    if (req.method === "GET" && req.url === "/credentials") {
      const rows = await db.select().from(credentials).where(eq(credentials.orgId, auth.orgId));
      return sendJson(res, rows);
    }

    if (req.method === "POST" && req.url === "/credentials") {
      await requireRole(auth.orgId, auth.userId, "admin");
      const body = await readJson(req);
      const id = crypto.randomUUID();
      await db.insert(credentials).values({ id, orgId: auth.orgId, name: body.name, kind: body.kind, secretRef: body.secretRef, metadata: body.metadata ?? {}, createdBy: auth.userId });
      await audit(auth.orgId, auth.userId, "credential.created", "credential", id, { kind: body.kind });
      return sendJson(res, { id });
    }

    if (req.method === "GET" && req.url?.startsWith("/audit")) {
      const rows = await db.select().from(auditLogs).where(eq(auditLogs.orgId, auth.orgId)).orderBy(desc(auditLogs.createdAt));
      return sendJson(res, rows.slice(0, 100));
    }

    if (req.method === "POST" && req.url === "/validate") return sendJson(res, validateWorkflow(await readJson(req)));

    // AI helpers
    if (req.method === "POST" && req.url === "/ai/generate-workflow") {
      const { prompt } = await readJson(req);
      if (!process.env.OPENAI_API_KEY) return sendJson(res, workflowTemplates[0].workflow);
      const response = await openai.responses.create({ model: "gpt-4o-mini", input: [{ role: "system", content: "Generate only valid JSON for a workflow DAG. Shape: {id,name,nodes:[{id,type,config}],edges:[{from,to,condition?}]}. Supported node types: http, tool, transform, condition, agent, multi_agent, agent_reflection, loop, ai, approval, webhook, noop." }, { role: "user", content: prompt }], text: { format: { type: "json_object" } } });
      return sendJson(res, JSON.parse(response.output_text || "{}"));
    }

    if (req.method === "POST" && req.url === "/ai/explain-workflow") {
      const { workflow } = await readJson(req);
      if (!process.env.OPENAI_API_KEY) return sendJson(res, { explanation: "This workflow contains nodes connected by edges and can be executed by the engine." });
      const response = await openai.responses.create({ model: "gpt-4o-mini", input: `Explain this workflow clearly: ${JSON.stringify(workflow)}` });
      return sendJson(res, { explanation: response.output_text });
    }

    // Runs
    if (req.method === "GET" && req.url === "/runs") {
      const rows = await db.select().from(runs).where(eq(runs.orgId, auth.orgId)).orderBy(desc(runs.createdAt));
      return sendJson(res, rows);
    }

    if (req.method === "GET" && req.url?.startsWith("/run")) {
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("runId");
      const run = await db.select().from(runs).where(eq(runs.id, runId!));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId!));
      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId!));
      return sendJson(res, { run: run[0], nodes, events });
    }

    if (req.method === "GET" && req.url?.startsWith("/status")) {
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("runId");
      const run = await db.select().from(runs).where(eq(runs.id, runId!));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId!));
      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId!));
      return sendJson(res, { nodes, events });
    }

    if (req.method === "GET" && req.url?.startsWith("/events")) {
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("runId");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
      const interval = setInterval(async () => {
        const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId!));
        sendEvent(res, events);
      }, 1000);
      req.on("close", () => clearInterval(interval));
      return;
    }

    if (req.method === "POST" && req.url === "/start") {
      await requireRole(auth.orgId, auth.userId, "editor");
      const workflow = await readJson(req);
      const validation = validateWorkflow(workflow);
      if (!validation.valid) return sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
      const result = await startRun({ ...workflow, orgId: auth.orgId, createdBy: auth.userId });
      await audit(auth.orgId, auth.userId, "run.started", "run", result.runId, { workflowId: workflow.id });
      return sendJson(res, result);
    }

    if (req.method === "POST" && req.url === "/resume") {
      await requireRole(auth.orgId, auth.userId, "editor");
      const { runId, nodeId } = await readJson(req);
      const result = await resumeRun(runId, nodeId);
      await audit(auth.orgId, auth.userId, "run.resumed", "run", runId, { nodeId });
      return sendJson(res, result);
    }

    return sendJson(res, { error: "Not found" }, 404);
  } catch (err: any) {
    return sendJson(res, { error: err.message }, err.statusCode || 500);
  }
});

server.listen(PORT, () => console.log(`API running on port ${PORT}`));
