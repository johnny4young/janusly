/**
 * Paced replay-campaign worker and durable publication reconciler.
 *
 * Used by `worker.ts`: one delayed campaign step drains at most one DLQ row,
 * then schedules the next step from the Postgres-owned due clock. A periodic
 * reconciler republishes due clocks after Redis/process failures.
 *
 * Invariants:
 * - One step performs at most one replay; pacing is never a loop sleep.
 * - Database dispatch + item leases make duplicate BullMQ jobs harmless.
 * - A persisted DLQ replay claim counts as accepted even when Queue.add throws;
 *   the node-publication reconciler owns that delivery repair.
 * - Cancellation prevents new item claims; an already claimed item may finish.
 */

import {
  claimNextReplayCampaignItem,
  claimReplayCampaignDispatch,
  completeReplayCampaignIfExhausted,
  completeReplayCampaignItem,
  deferReplayCampaignDispatch,
  getReplayCampaignDeadLetter,
  listDueReplayCampaigns,
  markReplayCampaignDeadLetterReplayed,
  recordSystemAudit,
  type ClaimedReplayCampaignItem,
  type ReplayCampaign,
} from "@janusly/data";
import { NodeSchema, WorkflowSchema } from "@janusly/shared";

import { normalizeErrorSignature } from "./error-signature";

export const REPLAY_CAMPAIGN_RECONCILER_JOB_ID = "system:replay-campaign-reconciler";
export const REPLAY_CAMPAIGN_RECONCILER_JOB_NAME = "replay-campaign-reconciler-trigger";
export const REPLAY_CAMPAIGN_STEP_JOB_NAME = "replay-campaign-step";
export const REPLAY_CAMPAIGN_RECONCILER_EVERY_MS = 15_000;
export const REPLAY_CAMPAIGN_RECONCILER_LIMIT = 100;

type ProcessReplayCampaignDeps = {
  claimDispatch: (campaignId: string, now: Date) => Promise<ReplayCampaign | null>;
  claimItem: (orgId: string, campaignId: string, now: Date) => Promise<ClaimedReplayCampaignItem | null>;
  replayItem: (campaign: ReplayCampaign, item: ClaimedReplayCampaignItem) => Promise<void>;
  settleItem: typeof completeReplayCampaignItem;
  completeIfExhausted: (orgId: string, campaignId: string, now: Date) => Promise<ReplayCampaign | null>;
  deferDispatch: (campaignId: string, delayMs?: number) => Promise<void>;
  schedule: (campaignId: string, dueAt: Date) => Promise<void>;
  audit: typeof recordSystemAudit;
};

export type ReplayCampaignStepResult = "skipped" | "replayed" | "failed" | "completed";

/** Execute one leased campaign step with per-item fault isolation. */
export async function processReplayCampaignStep(
  campaignId: string,
  deps: ProcessReplayCampaignDeps,
  now = new Date(),
): Promise<ReplayCampaignStepResult> {
  const campaign = await deps.claimDispatch(campaignId, now);
  if (!campaign) return "skipped";

  let itemSettled = false;
  try {
    const item = await deps.claimItem(campaign.orgId, campaign.id, now);
    if (!item) {
      const completed = await deps.completeIfExhausted(campaign.orgId, campaign.id, now);
      if (completed?.status === "completed") {
        await deps.audit({
          orgId: campaign.orgId,
          action: "recovery.campaign.completed",
          actor: "system:replay-campaign",
          targetType: "replay_campaign",
          targetId: campaign.id,
          metadata: {
            replayed: completed.replayedCount,
            failed: completed.failedCount,
            cancelled: completed.cancelledCount,
          },
          logTag: "[replay-campaign]",
        });
        return "completed";
      }
      return "skipped";
    }

    let outcome: "replayed" | "failed" = "replayed";
    let error: string | null = null;
    try {
      await deps.replayItem(campaign, item);
    } catch (caught) {
      outcome = "failed";
      error = caught instanceof Error ? caught.message : String(caught);
    }

    const updated = await deps.settleItem({
      orgId: campaign.orgId,
      campaignId: campaign.id,
      itemId: item.id,
      claimToken: item.claimToken,
      outcome,
      error,
      now: new Date(),
    });
    if (!updated) return "skipped";
    itemSettled = true;

    await deps.audit({
      orgId: campaign.orgId,
      action: outcome === "replayed"
        ? "recovery.campaign.item_replayed"
        : "recovery.campaign.item_failed",
      actor: campaign.createdBy,
      targetType: "dlq",
      targetId: item.deadLetterId,
      metadata: {
        campaignId: campaign.id,
        position: item.position,
        ...(error ? { error } : {}),
      },
      logTag: "[replay-campaign]",
    });

    if (updated.status === "running") {
      await deps.schedule(updated.id, updated.nextDispatchAt);
    } else if (updated.status === "completed") {
      await deps.audit({
        orgId: campaign.orgId,
        action: "recovery.campaign.completed",
        actor: "system:replay-campaign",
        targetType: "replay_campaign",
        targetId: campaign.id,
        metadata: {
          replayed: updated.replayedCount,
          failed: updated.failedCount,
          cancelled: updated.cancelledCount,
        },
        logTag: "[replay-campaign]",
      });
    }
    return outcome;
  } catch (error) {
    // Before an item settles, shorten the dispatch lease so the reconciler can
    // retry promptly. After settlement, the parent already owns the exact
    // configured pacing clock; never overwrite it because audit/Redis failed.
    if (!itemSettled) await deps.deferDispatch(campaign.id, 10_000);
    throw error;
  }
}

/** Replay the exact DLQ snapshot through the canonical generation claim. */
async function replayCampaignItem(
  campaign: ReplayCampaign,
  campaignItem: ClaimedReplayCampaignItem,
): Promise<void> {
  let deadLetter = await getReplayCampaignDeadLetter(campaign.orgId, campaignItem.deadLetterId);
  if (!deadLetter) throw new Error("DLQ entry not found");
  if (deadLetter.status === "replayed" && deadLetter.replayClaimedAt) return;
  if (deadLetter.status !== "open") throw new Error(`DLQ entry already ${deadLetter.status}`);

  const workflow = WorkflowSchema.parse(deadLetter.workflowJson);
  const node = NodeSchema.parse(deadLetter.nodeJson);
  const signature = normalizeErrorSignature(deadLetter.errorJson, {
    nodeId: deadLetter.nodeId,
    nodeType: node.type,
    toolName: typeof node.config?.tool === "string" ? node.config.tool : undefined,
  }).signature;
  if (signature !== campaign.clusterSignature) {
    throw new Error("DLQ entry signature no longer matches the campaign cohort");
  }

  const [adapterModule, recoveryItemModule] = await Promise.all([
    import("./adapters/dlq-replay"),
    import("./recovery/recovery-item-hook"),
  ]);
  const replayAdapter = new adapterModule.DLQReplayAdapter();
  await recoveryItemModule.createRecoveryItemForDeadLetter({
    orgId: campaign.orgId,
    deadLetterId: deadLetter.id,
    createdBy: campaign.createdBy,
    workflowId: workflow.id ?? null,
    errorSignature: signature,
  });

  try {
    await replayAdapter.replayDeadLetter({
      runId: deadLetter.runId,
      workflow,
      node,
      deadLetterId: deadLetter.id,
      recoveryActorId: campaign.createdBy,
    });
  } catch (error) {
    // The replay transition persists its generation before Queue.add. If Redis
    // failed after that commit, the normal publication reconciler still owns a
    // durable delivery promise, so the campaign item is accepted rather than
    // falsely reported failed and retried into a second external execution.
    deadLetter = await getReplayCampaignDeadLetter(campaign.orgId, campaignItem.deadLetterId);
    if (!deadLetter?.replayClaimedAt || !deadLetter.replayClaimToken) throw error;
  }
  await markReplayCampaignDeadLetterReplayed(campaign.orgId, deadLetter.id);
}

/** BullMQ entrypoint for one delayed campaign step. */
export async function handleReplayCampaignStep(data: unknown): Promise<void> {
  const campaignId = typeof (data as { campaignId?: unknown } | null)?.campaignId === "string"
    ? (data as { campaignId: string }).campaignId
    : null;
  if (!campaignId) throw new Error("Invalid replay campaign job: missing campaignId");
  const { enqueueReplayCampaignStep } = await import("./queue");
  await processReplayCampaignStep(campaignId, {
    claimDispatch: claimReplayCampaignDispatch,
    claimItem: claimNextReplayCampaignItem,
    replayItem: replayCampaignItem,
    settleItem: completeReplayCampaignItem,
    completeIfExhausted: completeReplayCampaignIfExhausted,
    deferDispatch: deferReplayCampaignDispatch,
    schedule: enqueueReplayCampaignStep,
    audit: recordSystemAudit,
  });
}

/** Register the bounded Postgres→BullMQ repair sweep. */
export async function registerReplayCampaignReconciler(): Promise<boolean> {
  try {
    const { workflowQueue } = await import("./queue");
    await workflowQueue.upsertJobScheduler(
      REPLAY_CAMPAIGN_RECONCILER_JOB_ID,
      { every: REPLAY_CAMPAIGN_RECONCILER_EVERY_MS },
      { name: REPLAY_CAMPAIGN_RECONCILER_JOB_NAME, data: {} },
    );
    return true;
  } catch (error) {
    console.error("[replay-campaign] reconciler registration failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Republish every due campaign clock; dispatch claims deduplicate delivery. */
export async function handleReplayCampaignReconcilerTrigger(): Promise<void> {
  try {
    const { enqueueReplayCampaignStep } = await import("./queue");
    const due = await listDueReplayCampaigns(new Date(), REPLAY_CAMPAIGN_RECONCILER_LIMIT);
    for (const campaign of due) {
      try {
        await enqueueReplayCampaignStep(campaign.id, campaign.nextDispatchAt);
      } catch (error) {
        console.warn("[replay-campaign] failed to republish due campaign", {
          campaignId: campaign.id,
          orgId: campaign.orgId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    console.error("[replay-campaign] reconciler sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
