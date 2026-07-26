/** Stable BullMQ ids for idempotent physical node-publication generations. */

import { createHash } from "node:crypto";
import type { EnqueueNodeInput } from "./core/types";

/**
 * Hash the execution identity plus its durable publication generation. A
 * producer retry reuses the id, while a consumed delivery rotates the
 * generation before repair so BullMQ cannot return an old active/completed job.
 */
export function buildExecuteNodeJobId(payload: EnqueueNodeInput): string {
  const generation = JSON.stringify([
    payload.runId,
    payload.nodeId,
    payload.attempt ?? 1,
    payload.recoveryClaimToken ?? null,
    payload.publicationGeneration ?? 0,
  ]);
  return `workflow-node-${createHash("sha256").update(generation).digest("hex")}`;
}

/** Stable id for one campaign due-clock generation without BullMQ separators. */
export function buildReplayCampaignJobId(campaignId: string, dueAt: Date): string {
  const generation = JSON.stringify([campaignId, dueAt.getTime()]);
  return `replay-campaign-${createHash("sha256").update(generation).digest("hex")}`;
}
