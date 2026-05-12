/**
 * `usage_events` write path for LLM telemetry. The single chokepoint registered
 * as the `LlmClient` recorder via `setUsageRecorder(recordUsage)` at api +
 * worker boot; every successful or failed LLM call lands one row here.
 *
 * The schema is intentionally generic: `metric` + `quantity` for fast
 * aggregation (already used by `getUsageSummary`), `metadata`
 * jsonb for everything provider/model/cost-specific. Writing rows with
 * `metric: "llm.completion"` + `quantity: totalTokens` makes the existing
 * billing dashboard (`GET /billing/usage` → web "Usage summary" card) light
 * up automatically without UI changes.
 *
 * Used by:
 * - `apps/api/src/index.ts` — boot path: `setUsageRecorder(recordUsage)`.
 * - `packages/engine/src/worker.ts` — boot path: `setUsageRecorder(recordUsage)`.
 *
 * Invariants:
 * - Multi-tenant scope: `orgId` is always set explicitly from the record.
 * - The chokepoint in `packages/ai/src/llm-client.ts` already wraps this in
 *   try/catch. This function may throw (DB failures); they're caught and
 *   dropped upstream because telemetry must never break an LLM call.
 */

import { db, usageEvents } from "@janusly/db";
import type { UsageRecord } from "@janusly/ai";

/**
 * Wire-shape for `email.send` usage rows. Mirrors
 * `packages/engine/src/email-usage.ts:EmailUsageRecord` — the engine
 * package can't be imported from `packages/data` without inverting
 * the dependency graph, so the shape is duplicated here. Update both
 * sites together if the row contract changes.
 */
type EmailUsageRecord = {
  orgId: string;
  runId?: string;
  nodeId?: string;
  workflowId?: string;
  to: string;
  from: string;
  provider: "resend" | "sendgrid" | "noop";
  providerMessageId?: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
};

export async function recordUsage(record: UsageRecord): Promise<void> {
  await db.insert(usageEvents).values({
    id: crypto.randomUUID(),
    orgId: record.orgId,
    userId: record.userId ?? null,
    runId: record.runId ?? null,
    metric: "llm.completion",
    quantity: record.totalTokens ?? 0,
    metadata: {
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens ?? null,
      outputTokens: record.outputTokens ?? null,
      latencyMs: record.latencyMs,
      costUsd: record.costUsd ?? null,
      nodeId: record.nodeId ?? null,
      // Workflow attribution — populated by /ai/* routes that have
      // the workflow in scope and by the engine's node executors via
      // `getRunMetadata`. Drives the `workflow` breakdown dimension
      // surfaced by `GET /billing/usage?breakdown=workflow`.
      workflowId: record.workflowId ?? null,
      mode: record.mode,
      aiError: record.aiError ?? null,
    },
  });
}

/**
 * Sister writer for `email.send` tool calls. Same `usage_events` table
 * (multi-tenant scope) but `metric: "email.sent"` and a different
 * metadata shape — provider / providerMessageId / ok / error /
 * recipient. The existing `getUsageBreakdown` aggregator picks these
 * rows up automatically; the workflow-axis breakdown surfaces email
 * cost per workflow without UI changes.
 *
 * Quantity is `1` (one email per row) — operators reading the flat
 * summary see "12 email.sent" alongside the LLM token totals.
 */
export async function recordEmailUsage(record: EmailUsageRecord): Promise<void> {
  await db.insert(usageEvents).values({
    id: crypto.randomUUID(),
    orgId: record.orgId,
    userId: null,
    runId: record.runId ?? null,
    metric: "email.sent",
    quantity: 1,
    metadata: {
      provider: record.provider,
      to: record.to,
      from: record.from,
      providerMessageId: record.providerMessageId ?? null,
      ok: record.ok,
      error: record.error ?? null,
      latencyMs: record.latencyMs,
      nodeId: record.nodeId ?? null,
      workflowId: record.workflowId ?? null,
    },
  });
}

/**
 * Wire-shape for integration-tool usage rows (Slack post, GitHub issue,
 * signed webhook, etc.). Mirrors
 * `packages/engine/src/integration-usage.ts:IntegrationUsageRecord` — the
 * engine package can't be imported from `packages/data` without inverting
 * the dependency graph, so the shape is duplicated here. Update both
 * sites together if the row contract changes.
 */
type IntegrationUsageRecord = {
  orgId: string;
  tool: string;
  credentialName: string;
  runId?: string;
  nodeId?: string;
  workflowId?: string;
  ok: boolean;
  statusCode?: number;
  error?: string;
  latencyMs: number;
};

/**
 * Wire-shape for `pdf.generate` usage rows. Mirrors
 * `packages/engine/src/pdf-usage.ts:PdfUsageRecord` — the engine package
 * can't be imported from `packages/data` without inverting the dependency
 * graph, so the shape is duplicated here. Update both sites together if
 * the row contract changes.
 */
type PdfUsageRecord = {
  orgId: string;
  runId?: string;
  nodeId?: string;
  workflowId?: string;
  provider: "s3" | "local" | "noop";
  key?: string;
  contentLength: number;
  ok: boolean;
  error?: string;
  latencyMs: number;
};

/**
 * Sister writer for `pdf.generate` tool calls. Same `usage_events` table
 * (multi-tenant scope) with `metric: "pdf.generated"` — operators see
 * "12 pdf.generated" alongside email + tool + LLM totals on the
 * existing `GET /billing/usage` dashboard. Quantity is the produced
 * PDF's byte length so the operator can size storage/cost off the same
 * row.
 */
export async function recordPdfUsage(record: PdfUsageRecord): Promise<void> {
  await db.insert(usageEvents).values({
    id: crypto.randomUUID(),
    orgId: record.orgId,
    userId: null,
    runId: record.runId ?? null,
    metric: "pdf.generated",
    quantity: record.contentLength,
    metadata: {
      provider: record.provider,
      key: record.key ?? null,
      ok: record.ok,
      error: record.error ?? null,
      contentLength: record.contentLength,
      latencyMs: record.latencyMs,
      nodeId: record.nodeId ?? null,
      workflowId: record.workflowId ?? null,
    },
  });
}

/**
 * Sister writer for integration tools. Same `usage_events` table
 * (multi-tenant scope) with `metric: "tool.<name>"` — operators see
 * "12 tool.slack.post" alongside the email + LLM totals on the existing
 * `GET /billing/usage` dashboard. Quantity is `1` per call (one tool
 * invocation per row).
 *
 * The credentialName field is the operator-friendly name (e.g.
 * "incidents-slack"), NOT the secret-ref env-var name. Never persist the
 * secret-ref through this path.
 */
export async function recordIntegrationUsage(record: IntegrationUsageRecord): Promise<void> {
  await db.insert(usageEvents).values({
    id: crypto.randomUUID(),
    orgId: record.orgId,
    userId: null,
    runId: record.runId ?? null,
    metric: `tool.${record.tool}`,
    quantity: 1,
    metadata: {
      tool: record.tool,
      credentialName: record.credentialName,
      ok: record.ok,
      statusCode: record.statusCode ?? null,
      error: record.error ?? null,
      latencyMs: record.latencyMs,
      nodeId: record.nodeId ?? null,
      workflowId: record.workflowId ?? null,
    },
  });
}
