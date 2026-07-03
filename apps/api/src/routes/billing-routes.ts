/**
 * Usage reporting. Default response is the existing flat
 * `Record<metric, quantity>` for back-compat. When the caller passes
 * `?breakdown=provider,model,mode,day,node,workflow` (any combination
 * of the closed-enum dimensions), the response also includes a
 * `breakdown` array of per-bucket aggregates (token totals, call count,
 * fallback count, costUsd, latency p50/p95/avg). Both paths read the
 * same bounded 30-day / 10k-row slice — the unbounded-scan invariant
 * stays intact.
 */

import { and, eq, isNull } from "drizzle-orm";

import {
  DEFAULT_USAGE_WINDOW_DAYS,
  getUsageBreakdown,
  getUsageSummary,
  isUsageBreakdownDimension,
  type UsageBreakdownDimension,
} from "@janusly/engine/src/billing";
import { checkBudget } from "@janusly/engine/src/budget";
import {
  getWorkflowBudget,
  upsertWorkflowBudget,
  type WorkflowBudgetPolicy,
} from "@janusly/data";
import { db, workflows } from "@janusly/db";

import { auditAction } from "../audit-helper";
import { asRecord, corsHeaders, readJson, sendError, sendJson } from "../http";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import type { Route } from "../routes";

/** RFC 4180 escaping — quote a cell when it carries a comma / quote / newline. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize a header + rows into a CRLF-delimited CSV string. */
function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Default rollup dimensions for the CSV export when the caller omits `?breakdown=`. */
const DEFAULT_EXPORT_DIMENSIONS: UsageBreakdownDimension[] = ["workflow", "model", "day"];

export const billingRoutes: Route[] = [
  // GET /billing/usage/export[?breakdown=workflow,model,day]
  // Streams the same bounded usage_events rollup as /billing/usage?breakdown=,
  // but formatted as a downloadable CSV (one row per aggregate bucket:
  // dimension columns + quantity / callCount / fallbackCount / costUsd /
  // latency p50,p95,avg). Makes the billing-page placeholder a real,
  // finance-friendly export without Stripe. Reuses getUsageBreakdown so the
  // 30-day / 10k-row bounded-scan invariant is preserved. Audited as
  // `billing.usage.exported`. Registered BEFORE the bare /billing/usage route
  // — the two matchers are disjoint (this needs the `/export` segment) but the
  // ordering keeps intent clear.
  { method: "GET", match: (url) => url === "/billing/usage/export" || url.startsWith("/billing/usage/export?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const raw = url.searchParams.get("breakdown");
      const tokens = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const dimensions: UsageBreakdownDimension[] = [];
      for (const token of tokens) {
        if (!isUsageBreakdownDimension(token)) {
          return sendError(res, "billing_unknown_breakdown_dimension", `Unknown breakdown dimension: {{dimension}}`, 400, { dimension: token });
        }
        if (!dimensions.includes(token)) dimensions.push(token);
      }
      const dims = dimensions.length > 0 ? dimensions : DEFAULT_EXPORT_DIMENSIONS;
      const breakdown = await getUsageBreakdown(auth.orgId, dims);
      const header = [...dims, "quantity", "callCount", "fallbackCount", "costUsd", "latencyP50Ms", "latencyP95Ms", "latencyAvgMs"];
      const rows = breakdown.map((b) => [
        ...dims.map((d) => (b as Record<string, unknown>)[d] ?? ""),
        b.quantity,
        b.callCount,
        b.fallbackCount,
        b.costUsd ?? "",
        b.latency.p50Ms ?? "",
        b.latency.p95Ms ?? "",
        b.latency.avgMs ?? "",
      ]);
      const csv = toCsv(header, rows);

      await auditAction(auth, "billing.usage.exported", { metadata: {
        dimensions: dims.join(","),
        rowCount: breakdown.length,
        windowDays: DEFAULT_USAGE_WINDOW_DAYS,
      } });

      const filename = `janusly-usage-${new Date().toISOString().slice(0, 10)}.csv`;
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        ...corsHeaders(res),
      });
      res.end(csv);
    } },

  { method: "GET", match: (url) => url === "/billing/usage" || url.startsWith("/billing/usage?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const raw = url.searchParams.get("breakdown");
      const tokens = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const dimensions: UsageBreakdownDimension[] = [];
      for (const token of tokens) {
        if (!isUsageBreakdownDimension(token)) {
          return sendError(res, "billing_unknown_breakdown_dimension", `Unknown breakdown dimension: {{dimension}}`, 400, { dimension: token });
        }
        if (!dimensions.includes(token)) dimensions.push(token);
      }
      const summary = await getUsageSummary(auth.orgId);
      if (dimensions.length === 0) {
        return sendJson(res, summary);
      }
      const breakdown = await getUsageBreakdown(auth.orgId, dimensions);
      return sendJson(res, { summary, breakdown, windowDays: DEFAULT_USAGE_WINDOW_DAYS });
    } },

  // GET /billing/budget?workflowId=<id>
  // Returns the current BudgetCheckResult envelope so the Recovery Center
  // Budget tile + Operations bar can render spend / limit / severity band.
  // Cheap read — no LLM call. Reused on every platformVersion tick.
  { method: "GET", match: (url) => url === "/billing/budget" || url.startsWith("/billing/budget?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workflowId = url.searchParams.get("workflowId") ?? undefined;
      const envelope = await checkBudget({ orgId: auth.orgId, workflowId });
      return sendJson(res, envelope);
    } },

  // POST /workflows/:id/budget
  // Admin route. Upserts the per-workflow override (monthlyUsd / warnPercent
  // / policy). Multi-tenant scope is enforced by validating the workflow
  // belongs to auth.orgId before the upsert. Audits every change as
  // `billing.budget.configured` with `{ scope: "workflow", before, after }`.
  { method: "POST", match: (url) => /^\/workflows\/[^/]+\/budget$/.test(url), role: "admin",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const match = url.pathname.match(/^\/workflows\/([^/]+)\/budget$/);
      const workflowId = match?.[1];
      if (!workflowId) return sendError(res, "billing_workflow_id_required", "workflowId path segment is required", 400);

      const workflowRow = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)))
        .limit(1);
      if (workflowRow.length === 0) {
        return sendError(res, "workflow_not_found", "Workflow not found", 404);
      }

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const monthlyUsd = typeof body.monthlyUsd === "number" ? body.monthlyUsd : null;
      if (monthlyUsd === null || !Number.isFinite(monthlyUsd) || monthlyUsd < 0) {
        return sendError(res, "billing_monthly_usd_invalid", "monthlyUsd must be a finite number >= 0", 400);
      }
      const warnPercentRaw = body.warnPercent;
      const warnPercent = typeof warnPercentRaw === "number" && Number.isFinite(warnPercentRaw)
        ? warnPercentRaw
        : undefined;
      if (warnPercent !== undefined && (!Number.isInteger(warnPercent) || warnPercent < 0 || warnPercent > 100)) {
        return sendError(res, "billing_warn_percent_invalid", "warnPercent must be an integer between 0 and 100", 400);
      }
      const policyRaw = body.policy;
      const policy: WorkflowBudgetPolicy | undefined = policyRaw === "warn" || policyRaw === "block"
        ? policyRaw
        : undefined;
      if (policyRaw !== undefined && policy === undefined) {
        return sendError(res, "billing_policy_invalid", "policy must be 'warn' or 'block'", 400);
      }

      const before = await getWorkflowBudget(auth.orgId, workflowId);
      const row = await upsertWorkflowBudget({
        orgId: auth.orgId,
        workflowId,
        monthlyUsd,
        warnPercent,
        policy,
        updatedBy: auth.userId,
      });

      await auditAction(auth, "billing.budget.configured", { targetType: "workflow", targetId: workflowId, metadata: {
        scope: "workflow",
        workflowId,
        before: before
          ? { monthlyUsd: before.monthlyUsd, warnPercent: before.warnPercent, policy: before.policy }
          : null,
        after: { monthlyUsd: row.monthlyUsd, warnPercent: row.warnPercent, policy: row.policy },
      } });

      return sendJson(res, row);
    } },
];
