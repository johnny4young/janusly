import http from "http";
import { startRun } from "@workflow-engine/engine/src/start-run";
import { db } from "@workflow-engine/db";
import { runNodes, runEvents } from "@workflow-engine/db";
import { eq } from "drizzle-orm";

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/start") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      const workflow = JSON.parse(body);
      const result = await startRun(workflow);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/status")) {
    const url = new URL(req.url, "http://localhost");
    const runId = url.searchParams.get("runId");

    const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId!));
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId!));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ nodes, events }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(3001, () => {
  console.log("API running on http://localhost:3001");
});
