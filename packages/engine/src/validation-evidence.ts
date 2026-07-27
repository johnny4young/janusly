import { db, runEvents, runs } from "@janusly/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { publishRunEvent } from "./run-event-stream";
import { safePersistPayload } from "./safe-persist";

/**
 * Records a skipped external effect and upgrades the run evidence in the same
 * transaction. Future stronger evidence is never downgraded by a late event.
 */
export async function recordValidationWriteSkip(
  runId: string,
  nodeId: string,
  type: "node.dry_run.skipped" | "tool.dry_run.skipped" | "loop.dry_run.skipped",
  payload: unknown,
): Promise<string> {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const redacted = safePersistPayload(payload);
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ validationEvidenceLevel: "writes_skipped" })
      .where(and(
        eq(runs.id, runId),
        eq(runs.replayMode, "validation"),
        or(
          isNull(runs.validationEvidenceLevel),
          inArray(runs.validationEvidenceLevel, ["static", "writes_skipped"]),
        ),
      ));
    await tx.insert(runEvents).values({
      id,
      runId,
      nodeId,
      type,
      payload: redacted,
      createdAt,
    });
  });
  publishRunEvent(runId, {
    kind: "event",
    id,
    nodeId,
    type,
    payload: redacted,
    createdAt: createdAt.toISOString(),
  });
  return id;
}
