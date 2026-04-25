import http from "http";
import { startRun } from "@workflow-engine/engine/src/start-run";
import { validateWorkflow } from "@workflow-engine/engine/src/workflow-validation";
import { listTools } from "@workflow-engine/engine/src/tool-registry";
import { requireAuth } from "./auth";
import { db } from "@workflow-engine/db";
import { runs } from "@workflow-engine/db";
import { eq, desc } from "drizzle-orm";

const PORT = Number(process.env.PORT || 3001);

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
    const auth = await requireAuth(req);

    if (req.method === "GET" && req.url === "/tools") {
      sendJson(res, listTools());
      return;
    }

    if (req.method === "GET" && req.url === "/runs") {
      const rows = await db.select().from(runs).where(eq(runs.orgId, auth.orgId)).orderBy(desc(runs.createdAt));
      sendJson(res, rows);
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

server.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
