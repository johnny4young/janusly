import http from "http";
import OpenAI from "openai";
import { startRun } from "@workflow-engine/engine/src/start-run";
import { resumeRun } from "@workflow-engine/engine/src/resume-run";
import { validateWorkflow } from "@workflow-engine/engine/src/workflow-validation";
import { listTools } from "@workflow-engine/engine/src/tool-registry";
import { getUsageSummary } from "@workflow-engine/engine/src/billing";
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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-org-id, x-user-id",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req: http.IncomingMessage) {
  return new Promise<any>((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, {});

  try {
    const auth = await requireAuth(req);

    // Members
    if (req.method === "GET" && req.url === "/members") {
      const rows = await db.select().from(orgMembers).where(eq(orgMembers.orgId, auth.orgId));
      return sendJson(res, rows);
    }

    if (req.method === "POST" && req.url === "/members/invite") {
      await requireRole(auth.orgId, auth.userId, 'admin')
      const body = await readJson(req);
      const id = crypto.randomUUID();
      await db.insert(orgMembers).values({ id, orgId: auth.orgId, userId: body.userId, email: body.email, role: body.role || 'viewer', invitedBy: auth.userId });
      return sendJson(res, { id });
    }

    if (req.method === "POST" && req.url === "/members/role") {
      await requireRole(auth.orgId, auth.userId, 'admin')
      const body = await readJson(req);
      await db.update(orgMembers).set({ role: body.role }).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, body.userId)));
      return sendJson(res, { ok: true });
    }

    // Protected actions
    if (req.method === "POST" && req.url === "/workflows/save") {
      await requireRole(auth.orgId, auth.userId, 'editor')
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
      return sendJson(res, { workflowId, versionId, version: nextVersion });
    }

    return sendJson(res, { ok: true });
  } catch (err: any) {
    return sendJson(res, { error: err.message }, err.statusCode || 500);
  }
});

server.listen(PORT, () => console.log(`API running on port ${PORT}`));
