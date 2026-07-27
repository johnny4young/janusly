import { db, runEvents, runs } from "@janusly/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { ProviderSimulationReceipt } from "./local-integration-simulator";
import { publishRunEvent } from "./run-event-stream";
import { safePersistPayload } from "./safe-persist";

export type ValidationEffectMode = "skip" | "provider_simulation";

/**
 * Records a skipped external effect and marks the whole validation run as
 * write-skipped. A receipt from another node cannot make a partially skipped
 * run look provider-complete.
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

/**
 * Persists a simulator-issued effect receipt and promotes the run only while
 * no write-side action has been skipped. The validation mode is read from the
 * immutable run envelope so a caller cannot upgrade an ordinary dry run.
 */
export async function recordValidationProviderReceipt(
  runId: string,
  nodeId: string,
  tool: string,
  receipt: ProviderSimulationReceipt,
): Promise<string> {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const payload = safePersistPayload({ tool, receipt });
  await db.transaction(async (tx) => {
    const promoted = await tx
      .update(runs)
      .set({ validationEvidenceLevel: "provider_simulated" })
      .where(and(
        eq(runs.id, runId),
        eq(runs.replayMode, "validation"),
        sql`${runs.inputJson}->>'validationEffectMode' = 'provider_simulation'`,
        or(
          isNull(runs.validationEvidenceLevel),
          inArray(runs.validationEvidenceLevel, ["static", "provider_simulated"]),
        ),
      ))
      .returning({ id: runs.id });
    if (!promoted[0]) {
      throw new Error("Provider simulation receipt rejected for this validation run");
    }
    await tx.insert(runEvents).values({
      id,
      runId,
      nodeId,
      type: "validation.provider.receipt",
      payload,
      createdAt,
    });
  });
  publishRunEvent(runId, {
    kind: "event",
    id,
    nodeId,
    type: "validation.provider.receipt",
    payload,
    createdAt: createdAt.toISOString(),
  });
  return id;
}
