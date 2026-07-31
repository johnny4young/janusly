/** Append-only run event persistence and best-effort live publication. */

import { db, runEvents } from "@janusly/db";
import { publishRunEvent } from "../run-event-stream";
import { safePersistPayload } from "../safe-persist";

/** Insert one row into `run_events` and return its id for additive event correlation. */
export async function appendEvent(runId: string, nodeId: string | null, type: string, payload: any): Promise<string> {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  // Redact ONCE, then both persist and publish the same object — a streamed
  // event can never expose a value the persisted row wouldn't.
  const redacted = safePersistPayload(payload);
  await db.insert(runEvents).values({
    id,
    runId,
    nodeId,
    type,
    payload: redacted,
    createdAt,
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
