/**
 * Named, paced, abortable replay-campaign API.
 *
 * Used by the Recovery Queue web surface. Campaign creation snapshots an
 * explicit bounded DLQ cohort; the worker drains one item per paced step.
 * Existing immediate `/dlq/bulk-replay` and cluster-apply routes remain
 * compatible for small synchronous operations.
 */

import { z } from "zod";

import {
  cancelReplayCampaign,
  createReplayCampaign,
  getReplayCampaign,
  listReplayCampaignDeadLetters,
  listReplayCampaigns,
  REPLAY_CAMPAIGN_MAX_ITEMS,
  REPLAY_CAMPAIGN_MAX_PACING_MS,
  REPLAY_CAMPAIGN_MIN_PACING_MS,
  REPLAY_CAMPAIGN_NAME_MAX_CHARS,
} from "@janusly/data";
import { enqueueReplayCampaignStep } from "@janusly/engine/src/queue";
import { NodeSchema } from "@janusly/shared";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { guardMcpWrite } from "../mcp-consent";
import type { Route } from "../routes";

const CohortBodySchema = z.object({
  deadLetterIds: z.array(z.string().trim().min(1).max(256))
    .min(1)
    .max(REPLAY_CAMPAIGN_MAX_ITEMS),
});

const CreateCampaignBodySchema = CohortBodySchema.extend({
  name: z.string().trim().min(1).max(REPLAY_CAMPAIGN_NAME_MAX_CHARS),
  pacingMs: z.number().int()
    .min(REPLAY_CAMPAIGN_MIN_PACING_MS)
    .max(REPLAY_CAMPAIGN_MAX_PACING_MS),
});

const CAMPAIGN_DETAIL_PATH = /^\/recovery\/campaigns\/([^/?]+)$/;
const CAMPAIGN_CANCEL_PATH = /^\/recovery\/campaigns\/([^/?]+)\/cancel$/;

function decodePathId(rawUrl: string | undefined, pattern: RegExp): string | null {
  const path = (rawUrl ?? "").split("?", 1)[0] ?? "";
  const match = pattern.exec(path);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

type CohortPreview = {
  canCreate: boolean;
  clusterSignature: string | null;
  eligible: Array<{ deadLetterId: string; runId: string; nodeId: string }>;
  rejected: Array<{ deadLetterId: string; reason: string }>;
};

/** Resolve one immutable cohort without trusting a client-supplied signature. */
async function previewCohort(orgId: string, requestedIds: string[]): Promise<CohortPreview> {
  const ids = [...new Set(requestedIds)];
  const rows = await listReplayCampaignDeadLetters(orgId, ids);
  const rowById = new Map(rows.map(row => [row.id, row]));
  const candidates: Array<{
    deadLetterId: string;
    runId: string;
    nodeId: string;
    signature: string;
  }> = [];
  const rejected: CohortPreview["rejected"] = [];

  for (const id of ids) {
    const row = rowById.get(id);
    if (!row) {
      rejected.push({ deadLetterId: id, reason: "not_found" });
      continue;
    }
    if (row.status !== "open") {
      rejected.push({ deadLetterId: id, reason: `already_${row.status}` });
      continue;
    }
    const parsedNode = NodeSchema.safeParse(row.nodeJson);
    if (!parsedNode.success) {
      rejected.push({ deadLetterId: id, reason: "invalid_node_snapshot" });
      continue;
    }
    const signature = normalizeErrorSignature(row.errorJson, {
      nodeId: row.nodeId,
      nodeType: parsedNode.data.type,
      toolName: typeof parsedNode.data.config?.tool === "string"
        ? parsedNode.data.config.tool
        : undefined,
    }).signature;
    candidates.push({ deadLetterId: id, runId: row.runId, nodeId: row.nodeId, signature });
  }

  const clusterSignature = candidates[0]?.signature ?? null;
  const eligible = candidates.filter(candidate => candidate.signature === clusterSignature)
    .map(({ deadLetterId, runId, nodeId }) => ({ deadLetterId, runId, nodeId }));
  for (const candidate of candidates) {
    if (candidate.signature !== clusterSignature) {
      rejected.push({ deadLetterId: candidate.deadLetterId, reason: "different_cluster" });
    }
  }
  return {
    canCreate: eligible.length >= 2 && rejected.length === 0 && eligible.length === ids.length,
    clusterSignature,
    eligible,
    rejected,
  };
}

export const replayCampaignsRoutes: Route[] = [
  {
    method: "POST",
    match: "/recovery/campaigns/preview",
    role: "editor",
    permission: "dlq.replay",
    handler: async ({ req, res, auth }) => {
      const parsed = CohortBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!parsed.success) return sendError(res, "replay_campaign_invalid_body", "Invalid replay campaign cohort", 400);
      return sendJson(res, await previewCohort(auth.orgId, parsed.data.deadLetterIds));
    },
  },
  {
    method: "POST",
    match: url => CAMPAIGN_CANCEL_PATH.test(url.split("?", 1)[0] ?? ""),
    role: "editor",
    permission: "dlq.replay",
    handler: async ({ req, res, auth }) => {
      const gate = await guardMcpWrite(auth, "dlq.replay");
      if (!gate.ok) return sendJson(res, gate.body, gate.status);
      const id = decodePathId(req.url, CAMPAIGN_CANCEL_PATH);
      if (!id) return sendError(res, "replay_campaign_invalid_path", "Invalid replay campaign id", 400);
      const detail = await cancelReplayCampaign(auth.orgId, id, auth.userId);
      if (!detail) {
        const existing = await getReplayCampaign(auth.orgId, id);
        if (!existing) return sendError(res, "replay_campaign_not_found", "Replay campaign not found", 404);
        return sendError(res, "replay_campaign_not_running", "Replay campaign is no longer running", 409);
      }
      await auditAction(auth, "recovery.campaign.cancelled", {
        targetType: "replay_campaign",
        targetId: id,
        metadata: {
          replayed: detail.campaign.replayedCount,
          failed: detail.campaign.failedCount,
          cancelled: detail.campaign.cancelledCount,
        },
      });
      return sendJson(res, detail);
    },
  },
  {
    method: "POST",
    match: "/recovery/campaigns",
    role: "editor",
    permission: "dlq.replay",
    handler: async ({ req, res, auth }) => {
      const gate = await guardMcpWrite(auth, "dlq.replay");
      if (!gate.ok) return sendJson(res, gate.body, gate.status);
      const parsed = CreateCampaignBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!parsed.success) return sendError(res, "replay_campaign_invalid_body", "Invalid replay campaign", 400);
      const cohort = await previewCohort(auth.orgId, parsed.data.deadLetterIds);
      if (!cohort.canCreate || !cohort.clusterSignature) {
        return sendError(res, "replay_campaign_invalid_cohort", "Replay campaign entries must be open members of one failure cluster", 409, {
          rejectedCount: cohort.rejected.length,
          eligibleCount: cohort.eligible.length,
        });
      }

      const detail = await createReplayCampaign({
        orgId: auth.orgId,
        name: parsed.data.name,
        clusterSignature: cohort.clusterSignature,
        deadLetterIds: cohort.eligible.map(item => item.deadLetterId),
        pacingMs: parsed.data.pacingMs,
        createdBy: auth.userId,
        filterJson: { kind: "failure_cluster", clusterSignature: cohort.clusterSignature },
      });
      let publicationDeferred = false;
      try {
        await enqueueReplayCampaignStep(detail.campaign.id, detail.campaign.nextDispatchAt);
      } catch {
        // The Postgres due clock remains authoritative; the worker reconciler
        // republishes it. Do not turn a durable accepted campaign into a 500.
        publicationDeferred = true;
      }
      await auditAction(auth, "recovery.campaign.created", {
        targetType: "replay_campaign",
        targetId: detail.campaign.id,
        metadata: {
          total: detail.campaign.totalCount,
          pacingMs: detail.campaign.pacingMs,
          clusterSignature: detail.campaign.clusterSignature,
          publicationDeferred,
        },
      });
      return sendJson(res, { ...detail, publicationDeferred }, 202);
    },
  },
  {
    method: "GET",
    match: url => CAMPAIGN_DETAIL_PATH.test(url.split("?", 1)[0] ?? ""),
    role: "viewer",
    permission: "dlq.read",
    handler: async ({ req, res, auth }) => {
      const id = decodePathId(req.url, CAMPAIGN_DETAIL_PATH);
      if (!id) return sendError(res, "replay_campaign_invalid_path", "Invalid replay campaign id", 400);
      const detail = await getReplayCampaign(auth.orgId, id);
      if (!detail) return sendError(res, "replay_campaign_not_found", "Replay campaign not found", 404);
      return sendJson(res, detail);
    },
  },
  {
    method: "GET",
    match: url => url === "/recovery/campaigns" || url.startsWith("/recovery/campaigns?"),
    role: "viewer",
    permission: "dlq.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(requested) ? requested : 20;
      return sendJson(res, { campaigns: await listReplayCampaigns(auth.orgId, limit) });
    },
  },
];
