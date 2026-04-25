import { db } from "@workflow-engine/db";
import { runs } from "@workflow-engine/db";
import { eq } from "drizzle-orm";
import { markNodeSucceeded, appendEvent } from "./persistence";
import { enqueueNextNodes } from "./scheduler";

export async function resumeRun(runId: string, nodeId: string) {
  const run = await db.select().from(runs).where(eq(runs.id, runId));

  if (!run[0]) {
    throw new Error("Run not found");
  }

  const workflow = run[0].inputJson.workflow;

  await markNodeSucceeded(runId, nodeId);
  await appendEvent(runId, nodeId, "node.resumed", {});

  await enqueueNextNodes({ runId, workflow });

  return { resumed: true };
}
