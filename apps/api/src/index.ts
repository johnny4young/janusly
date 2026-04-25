import http from "http";
import { startRun } from "@workflow-engine/engine/src/start-run";
import { resumeRun } from "@workflow-engine/engine/src/resume-run";
import { db } from "@workflow-engine/db";
import { workflows, workflowVersions, runNodes, runEvents } from "@workflow-engine/db";
import { eq, desc } from "drizzle-orm";

function sendJson(res: http.ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req: http.IncomingMessage) {
  return new Promise<any>((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, {});
    return;
  }

  try {
    if (req.method === "POST" && req.url === "/start") {
      const workflow = await readJson(req);
      const result = await startRun(workflow);
      sendJson(res, result);
      return;
    }

    if (req.method === "POST" && req.url === "/resume") {
      const { runId, nodeId } = await readJson(req);
      const result = await resumeRun(runId, nodeId);
      sendJson(res, result);
      return;
    }

    if (req.method === "POST" && req.url === "/workflows/save") {
      const workflow = await readJson(req);
      const workflowId = workflow.id ?? crypto.randomUUID();

      const existingVersions = await db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.workflowId, workflowId))
        .orderBy(desc(workflowVersions.version));

      const nextVersion = (existingVersions[0]?.version ?? 0) + 1;

      const existingWorkflow = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, workflowId));

      if (!existingWorkflow[0]) {
        await db.insert(workflows).values({
          id: workflowId,
          name: workflow.name ?? workflowId,
        });
      }

      const versionId = crypto.randomUUID();

      await db.insert(workflowVersions).values({
        id: versionId,
        workflowId,
        version: nextVersion,
        dagJson: { ...workflow, id: workflowId },
      });

      sendJson(res, { workflowId, versionId, version: nextVersion });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/workflows/latest")) {
      const url = new URL(req.url, "http://localhost");
      const workflowId = url.searchParams.get("workflowId") ?? "ui-test";

      const versions = await db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.workflowId, workflowId))
        .orderBy(desc(workflowVersions.version));

      sendJson(res, versions[0] ?? null);
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/status")) {
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("runId");

      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId!));
      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId!));

      sendJson(res, { nodes, events });
      return;
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (err: any) {
    sendJson(res, { error: err.message ?? "Internal error" }, 500);
  }
});

server.listen(3001, () => {
  console.log("API running on http://localhost:3001");
});
