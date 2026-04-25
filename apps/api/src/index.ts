import http from "http";
import { startRun } from "@workflow-engine/engine/src/start-run";
import { resumeRun } from "@workflow-engine/engine/src/resume-run";
import { validateWorkflow } from "@workflow-engine/engine/src/workflow-validation";
import { listTools } from "@workflow-engine/engine/src/tool-registry";
import { requireAuth } from "./auth";
import { db } from "@workflow-engine/db";
import { workflows, workflowVersions, runs, runNodes, runEvents } from "@workflow-engine/db";
import { eq, desc } from "drizzle-orm";

function sendJson(res: http.ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
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
  if (req.method === "OPTIONS") {
    sendJson(res, {});
    return;
  }

  try {
    const auth = requireAuth(req);

    if (req.method === "GET" && req.url === "/tools") {
      sendJson(res, listTools());
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/runs")) {
      const rows = await db.select().from(runs).where(eq(runs.orgId, auth.orgId)).orderBy(desc(runs.createdAt));
      sendJson(res, rows);
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/run")) {
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("runId");

      const run = await db.select().from(runs).where(eq(runs.id, runId!));

      if (run[0]?.orgId !== auth.orgId) {
        sendJson(res, { error: "Forbidden" }, 403);
        return;
      }

      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId!));
      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId!));

      sendJson(res, { run: run[0], nodes, events });
      return;
    }

    if (req.method === "POST" && req.url === "/start") {
      const workflow = await readJson(req);

      const validation = validateWorkflow(workflow);
      if (!validation.valid) {
        sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
        return;
      }

      const result = await startRun(workflow);
      sendJson(res, result);
      return;
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (err: any) {
    sendJson(res, { error: err.message }, err.statusCode || 500);
  }
});

server.listen(3001);
