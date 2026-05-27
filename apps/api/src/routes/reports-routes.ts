/**
 * Run Explain Report — exportable Markdown + JSON artefact for a
 * single run. Surfaces failure context (timeline, root cause, failed
 * node, attempts, suggested fix from prior recovery audit, next
 * action) so an operator can share what happened with a stakeholder.
 *
 * Read-only — no DB mutation outside the audit row. Multi-tenant
 * scoped via `eq(runs.orgId, auth.orgId)` on the run lookup. Every
 * accepted export writes a `report.run_explain.exported` audit row so
 * there's a trail of who exported what.
 */

import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import { auditLogs, db, runEvents, runNodes, runs } from "@janusly/db";
import { buildRunExplainReport, type RunExplainReport } from "@janusly/engine/src/run-explain-report";
import { composeRecoveryMetrics, type RecoveryMetrics } from "@janusly/engine/src/recovery-metrics";
import { collectRecoveryMetricsSignals } from "@janusly/data/src/recoveryMetricsRepo";
import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";
import { executeTool } from "@janusly/engine/src/tool-registry";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";

import { audit } from "../audit";
import { HTTP_CAPS, RATE_LIMIT_WINDOW_MS } from "../constants";
import { corsHeaders, readJson, sendJson } from "../http";
import { enforceRateLimit } from "../rate-limit";
import type { Route } from "../routes";

/**
 * Slugify a free-form string into a filesystem-safe lowercase token.
 * Keeps `[a-z0-9_-]` and collapses every other char (whitespace,
 * punctuation, non-ASCII) into a single dash. Trims leading/trailing
 * dashes and clamps length so a runaway workflow name can't blow up
 * the filename. Empty input or all-trimmed-away returns "".
 */
function slugify(value: string, maxLen = 40): string {
  return scrubSecretShapes(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}

/**
 * Build the human-readable filename for a run-explain download.
 * Pattern: `janusly-<workflow_or_run>-<status>-<YYYY-MM-DD>-<short_id>.<ext>`
 * Examples:
 *   - `janusly-billing_flow-failed-2026-05-12-b3dc412b.md`
 *   - `janusly-run-7f3a91-succeeded-2026-05-12.md` (no resolved name)
 *
 * UUIDs are shortened to 8 chars (long enough to disambiguate within a
 * day, short enough to fit a download history row). Non-ASCII workflow
 * names slug through to ASCII so the filesystem-safe `filename=` ASCII
 * fallback in Content-Disposition still works; the RFC 5987 `filename*=`
 * carries the full UTF-8 form for browsers that prefer it.
 */
function buildReportFilename(args: {
  runId: string;
  workflowName: string | null;
  status: string;
  createdAt: Date | string | null;
  format: "markdown" | "json";
}): { asciiFilename: string; utf8Filename: string } {
  const slugSource = args.workflowName ? slugify(args.workflowName) : "";
  // When a workflow name resolves, namePart is the slug AND we still
  // append shortId for disambiguation. When it doesn't, namePart is
  // just "run" — appending the short id at the end gives the disambiguator
  // without doubling it.
  const namePart = slugSource || "run";
  const statusSlug = slugify(args.status) || "unknown";
  const datePart = (() => {
    if (!args.createdAt) return "undated";
    const date = args.createdAt instanceof Date ? args.createdAt : new Date(args.createdAt);
    if (Number.isNaN(date.getTime())) return "undated";
    return date.toISOString().slice(0, 10);
  })();
  const shortId = slugify(args.runId.slice(0, 8)) || args.runId.slice(0, 8);
  const ext = args.format === "json" ? "json" : "md";

  // The ASCII filename is always filesystem-safe (slugify guarantees it).
  // The UTF-8 form is the same here because we don't carry the raw
  // workflow name through, but the helper structure keeps the two
  // forms distinct so a future change that preserves the raw name in
  // the UTF-8 branch only has to swap one line.
  const base = `janusly-${namePart}-${statusSlug}-${datePart}-${shortId}.${ext}`;
  return { asciiFilename: base, utf8Filename: base };
}

/**
 * Build a Content-Disposition header value that's safe in every
 * browser. Sends both `filename="<ascii>"` (RFC 6266 fallback) and
 * `filename*=UTF-8''<percent-encoded>` (RFC 5987) so non-ASCII names
 * survive on browsers that prefer the encoded form.
 */
function contentDispositionAttachment(ascii: string, utf8: string): string {
  // RFC 5987 percent-encodes byte-by-byte per the `attr-char` set.
  // `encodeURIComponent` covers what we need (plus a few that aren't
  // strictly required but are still safe to encode).
  const encoded = encodeURIComponent(utf8);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Body schema for `POST /reports/run-explain/deliver`. The shape stays a
 * single non-union object (no discriminated union) so the Zod parse remains
 * one pass and the dispatcher's TypeScript handling is uniform. Per-`kind`
 * required-fields are enforced via `superRefine`; the integration tool's
 * own input schema is the final gate.
 *
 * `credentialName` is the operator-visible credential identifier (e.g.
 * "ops-channel"), NOT the env-var that backs the secret. The env-var name
 * never appears in this route's request, response, or audit metadata.
 */
const deliverRequestSchema = z
  .object({
    runId: z.string().min(1),
    destination: z.object({
      kind: z.enum(["slack", "github", "webhook"]),
      credentialName: z.string().min(1),
      // GitHub-only fields.
      owner: z.string().min(1).optional(),
      repo: z.string().min(1).optional(),
      labels: z.array(z.string().min(1)).max(10).optional(),
      // Webhook-only field.
      url: z.string().url().optional(),
    }),
  })
  .superRefine((value, ctx) => {
    const dest = value.destination;
    if (dest.kind === "github") {
      if (!dest.owner) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destination", "owner"], message: "owner is required for github destination" });
      }
      if (!dest.repo) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destination", "repo"], message: "repo is required for github destination" });
      }
    }
    if (dest.kind === "webhook") {
      if (!dest.url) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destination", "url"], message: "url is required for webhook destination" });
      }
    }
  });

/** Cap below Slack's per-block 3000-char limit; leaves headroom for the header + footer. */
const SLACK_TEXT_MAX = HTTP_CAPS.SLACK_BLOCK_CHARS;
/** Outer route-level rate-limit bucket. Inner per-tool bucket (`tool.<name>`) is enforced inside the chokepoint. */
const REPORTS_DELIVER_RATE_LIMIT_BUCKET = "reports.deliver";
/** Outer-bucket default — 60/min/org for report delivery. */
const REPORTS_DELIVER_RATE_LIMIT_PER_MIN = 60;

/**
 * Build the Slack-bound text body from the report's structured JSON.
 * The structured JSON is the source of truth here (not the Markdown
 * rendering) so the helper stays predictable for tests and surfaces the
 * highest-signal fields first.
 *
 * Layout:
 *   *Janusly run explain: <name> – <status> – <short_id>*
 *   Root cause: <signature> (<category>)
 *   Failed node: <nodeId> — <errorSummary>
 *   Next action: <nextAction>
 *   Full report: <app-url>/reports/run-explain?runId=<runId>   (only when JANUSLY_PUBLIC_APP_URL is set)
 *
 * Truncated to `SLACK_TEXT_MAX` chars and trailing-ellipsised when over cap.
 */
function buildSlackText(args: {
  report: RunExplainReport;
  workflowName: string | null;
  runId: string;
}): string {
  const { report, workflowName, runId } = args;
  const shortId = runId.slice(0, 8);
  const displayName = workflowName ?? "(ad-hoc workflow)";
  const headerLine = `*Janusly run explain: ${displayName} – ${report.json.summary.status} – ${shortId}*`;

  const lines: string[] = [headerLine];

  if (report.json.rootCause) {
    lines.push(`Root cause: ${report.json.rootCause.signature} (${report.json.rootCause.category})`);
  }
  if (report.json.failedNode) {
    lines.push(`Failed node: ${report.json.failedNode.nodeId} — ${report.json.failedNode.errorSummary}`);
  }
  if (report.json.nextAction) {
    lines.push(`Next action: ${report.json.nextAction}`);
  }

  const publicBase = process.env.JANUSLY_PUBLIC_APP_URL;
  if (publicBase && publicBase.trim().length > 0) {
    const trimmed = publicBase.replace(/\/$/, "");
    lines.push(`Full report: ${trimmed}/reports/run-explain?runId=${encodeURIComponent(runId)}`);
  }

  const body = lines.join("\n");
  if (body.length <= SLACK_TEXT_MAX) return body;
  // The header line is always preserved; truncate the body and append an
  // ellipsis so receivers see a clear signal that content was cut.
  return `${body.slice(0, SLACK_TEXT_MAX - 1)}…`;
}

/** Build the GitHub issue title — `<name> – <status> (<short_id>)`. Falls back to `(ad-hoc workflow)` when unsaved. */
function buildGitHubTitle(args: {
  workflowName: string | null;
  runStatus: string;
  runId: string;
}): string {
  const shortId = args.runId.slice(0, 8);
  const displayName = args.workflowName ?? "(ad-hoc workflow)";
  return `Janusly run explain: ${displayName} – ${args.runStatus} (${shortId})`;
}

type DeliveryOutcome = {
  ok: boolean;
  statusCode?: number;
  error?: string;
  latencyMs: number;
  deliveryId?: string;
};

/**
 * Translate the report into the destination tool's input shape and call
 * `executeTool`. The chokepoint enforces credential resolution, per-tool
 * rate-limit, usage events, and SSRF/body-cap/timeout guards via
 * `fetchHttpTarget`. The dispatcher itself never throws on runtime
 * failure (missing credential, non-2xx, network blip) — it returns
 * `{ ok: false, error, ... }` so the route can audit and respond
 * uniformly.
 *
 * dryRun posture: writeSide tools normally honour `executionContext.dryRun`
 * to skip the upstream call from a `replayMode="validation"` workflow run.
 * This route runs outside a workflow run, so the runtime dryRun gate isn't
 * applicable here; the rate-limit + credential + audit gates are the
 * right safeguards at this layer.
 */
async function dispatchDelivery(args: {
  orgId: string;
  runId: string;
  destination: z.infer<typeof deliverRequestSchema>["destination"];
  report: RunExplainReport;
  workflowName: string | null;
}): Promise<DeliveryOutcome> {
  const { orgId, runId, destination, report, workflowName } = args;
  const ctx = {
    orgId,
    // Pass the source runId for traceability in usage_events. The
    // integration tool's recorder writes runId verbatim; nodeId /
    // workflowId stay unset (this is a route-level call, not a
    // workflow-node execution).
    runId,
  };

  try {
    if (destination.kind === "slack") {
      const text = buildSlackText({ report, workflowName, runId });
      const result = await executeTool(
        "slack.post",
        { credential: destination.credentialName, text },
        {},
        ctx,
      );
      return normalizeDeliveryResult(result);
    }

    if (destination.kind === "github") {
      const result = await executeTool(
        "github.create_issue",
        {
          credential: destination.credentialName,
          owner: destination.owner!,
          repo: destination.repo!,
          title: buildGitHubTitle({ workflowName, runStatus: report.json.summary.status, runId }),
          body: report.markdown,
          ...(destination.labels && destination.labels.length > 0 ? { labels: destination.labels } : {}),
        },
        {},
        ctx,
      );
      const issueUrl = typeof result.url === "string" ? result.url : undefined;
      return { ...normalizeDeliveryResult(result), deliveryId: issueUrl };
    }

    // webhook
    const result = await executeTool(
      "webhook.send",
      {
        credential: destination.credentialName,
        url: destination.url!,
        // The structured JSON envelope is the most useful shape for an
        // automated webhook receiver. The exact serialised body is what
        // the tool's HMAC-SHA256 path signs — the receiver verifies with
        // the same shared secret.
        payload: report.json as Record<string, unknown>,
      },
      {},
      ctx,
    );
    return normalizeDeliveryResult(result);
  } catch (err) {
    // executeTool throws on (a) unknown tool name or (b) zod input/output
    // validation failure. Neither is reachable in practice given the route
    // gates inputs upfront, but the route mirrors the tool contract by
    // never propagating throws — convert to a `{ ok: false }` envelope so
    // the outer audit row still gets written.
    const message = err instanceof Error ? err.message : "delivery failed";
    return { ok: false, error: message, latencyMs: 0 };
  }
}

function normalizeDeliveryResult(result: Record<string, unknown>): DeliveryOutcome {
  return {
    ok: result.ok === true,
    statusCode: typeof result.statusCode === "number" ? result.statusCode : undefined,
    error: typeof result.error === "string" ? result.error : undefined,
    latencyMs: typeof result.latencyMs === "number" ? result.latencyMs : 0,
  };
}

/**
 * Read the saved run snapshot + its rendered report. Same data flow as the
 * GET route — multi-tenant gate on the run lookup, recovery-audit join,
 * builder invocation. Returns `null` when the run doesn't belong to
 * `orgId` so the route can 404 uniformly without an enumeration leak.
 */
type LoadedRunReport = {
  /** Run-level fields the POST handler needs for audit metadata. */
  runStatus: string;
  runInputJson: unknown;
  report: RunExplainReport;
  workflowName: string | null;
  recoveryAuditFound: boolean;
};

async function loadRunReport(args: {
  orgId: string;
  runId: string;
}): Promise<LoadedRunReport | null> {
  const { orgId, runId } = args;
  const runRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.orgId, orgId)));
  const run = runRows[0];
  if (!run) return null;

  const nodes = await db
    .select()
    .from(runNodes)
    .where(eq(runNodes.runId, runId))
    .orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));

  const events = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
    .limit(200);

  const auditRows = await db
    .select()
    .from(auditLogs)
    .where(and(
      eq(auditLogs.orgId, orgId),
      eq(auditLogs.action, "ai.workflow.patch_suggested"),
      or(
        sql`${auditLogs.metadata} ->> 'runId' = ${runId}`,
        eq(auditLogs.targetId, runId),
      ),
    ))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  const matchingAudit = auditRows[0] ?? null;

  const report = buildRunExplainReport({
    run: {
      id: run.id,
      status: run.status,
      workflowVersionId: run.workflowVersionId,
      parentRunId: run.parentRunId,
      replayMode: run.replayMode,
      createdAt: run.createdAt,
      inputJson: run.inputJson,
      outputJson: run.outputJson,
    },
    runNodes: nodes.map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      attempts: node.attempts,
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      stateJson: node.stateJson,
      errorJson: node.errorJson,
    })),
    runEvents: events.map((event) => ({
      id: event.id,
      nodeId: event.nodeId,
      type: event.type,
      createdAt: event.createdAt,
      payload: event.payload,
    })),
    recoveryAudit: matchingAudit
      ? {
          createdAt: matchingAudit.createdAt,
          metadata: matchingAudit.metadata as Record<string, unknown>,
        }
      : null,
  });

  const inputJson = run.inputJson as { workflow?: { name?: unknown; id?: unknown } } | null;
  const workflowName = typeof inputJson?.workflow?.name === "string" ? inputJson.workflow.name : null;
  return {
    runStatus: run.status,
    runInputJson: run.inputJson,
    report,
    workflowName,
    recoveryAuditFound: matchingAudit !== null,
  };
}

export const reportsRoutes: Route[] = [
  // GET /reports/run-explain?runId=<id>&format=markdown|json
  // Returns a downloadable Markdown artefact by default; JSON when
  // explicitly requested for programmatic consumers. Org-scoped on
  // the run lookup; cross-org / missing run id returns a uniform 404
  // (no enumeration leak).
  { method: "GET", match: (url) => url.startsWith("/reports/run-explain"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      const formatRaw = (url.searchParams.get("format") ?? "markdown").toLowerCase();

      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      if (formatRaw !== "markdown" && formatRaw !== "json") {
        return sendJson(res, { error: `Unknown format: ${formatRaw}. Use "markdown" or "json".` }, 400);
      }

      // Multi-tenant gate. A run that isn't owned by `auth.orgId`
      // returns the same 404 as a missing id — no enumeration distinction.
      const runRows = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.orgId, auth.orgId)));
      const run = runRows[0];
      if (!run) return sendJson(res, { error: "Run not found" }, 404);

      const nodes = await db
        .select()
        .from(runNodes)
        .where(eq(runNodes.runId, runId))
        .orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));

      // Pull recent events for the timeline. The builder applies its
      // own cap; an over-cap fetch here would be wasted work, so we
      // bound the read to a comfortable multiple of the cap so the
      // builder always has enough material.
      const events = await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(200);

      // Most recent recovery audit for this run, if any. Patch
      // suggestions target the DLQ row, so the route stamps
      // `metadata.runId` as the stable cross-reference. Keep the
      // run-id predicate in SQL instead of fetching the last N audit
      // rows for the whole org; busy orgs can easily have more than N
      // unrelated suggestions after the one this report needs.
      const auditRows = await db
        .select()
        .from(auditLogs)
        .where(and(
          eq(auditLogs.orgId, auth.orgId),
          eq(auditLogs.action, "ai.workflow.patch_suggested"),
          or(
            sql`${auditLogs.metadata} ->> 'runId' = ${runId}`,
            eq(auditLogs.targetId, runId),
          ),
        ))
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
      const matchingAudit = auditRows[0] ?? null;

      const report = buildRunExplainReport({
        run: {
          id: run.id,
          status: run.status,
          workflowVersionId: run.workflowVersionId,
          parentRunId: run.parentRunId,
          replayMode: run.replayMode,
          createdAt: run.createdAt,
          inputJson: run.inputJson,
          outputJson: run.outputJson,
        },
        runNodes: nodes.map((node) => ({
          nodeId: node.nodeId,
          status: node.status,
          attempts: node.attempts,
          startedAt: node.startedAt,
          finishedAt: node.finishedAt,
          stateJson: node.stateJson,
          errorJson: node.errorJson,
        })),
        runEvents: events.map((event) => ({
          id: event.id,
          nodeId: event.nodeId,
          type: event.type,
          createdAt: event.createdAt,
          payload: event.payload,
        })),
        recoveryAudit: matchingAudit
          ? {
              createdAt: matchingAudit.createdAt,
              metadata: matchingAudit.metadata as Record<string, unknown>,
            }
          : null,
      });

      await audit(auth.orgId, auth.userId, "report.run_explain.exported", "run", runId, {
        format: formatRaw,
        recoveryAuditFound: matchingAudit !== null,
      });

      // Resolve a human-readable workflow name from the run's
      // `inputJson.workflow.name` snapshot (set by `startRun` for both
      // saved and ad-hoc runs). Empty / non-string falls through to the
      // generic `run-<short>` form in `buildReportFilename`.
      const inputJson = run.inputJson as { workflow?: { name?: unknown } } | null;
      const workflowName = typeof inputJson?.workflow?.name === "string" ? inputJson.workflow.name : null;
      const { asciiFilename, utf8Filename } = buildReportFilename({
        runId,
        workflowName,
        status: run.status,
        createdAt: run.createdAt,
        format: formatRaw,
      });

      if (formatRaw === "json") {
        // Use the same disposition pattern for JSON so an operator who
        // saves the response gets a filename instead of "download.bin".
        // sendJson sets Content-Type; we layer the disposition + CORS
        // expose header on top by writing the response manually.
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": contentDispositionAttachment(asciiFilename, utf8Filename),
          "Access-Control-Expose-Headers": "Content-Disposition",
          ...corsHeaders(res),
        });
        res.end(JSON.stringify(report.json));
        return;
      }

      // Markdown download path — write the body directly with a
      // `Content-Disposition: attachment` header so the browser
      // downloads as a file rather than rendering inline. The
      // `Access-Control-Expose-Headers` value lets the web's
      // `downloadFromApi` helper read the filename from JS (without
      // this CORS exposure the browser hides the header and the
      // helper falls back to a generic name).
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": contentDispositionAttachment(asciiFilename, utf8Filename),
        "Access-Control-Expose-Headers": "Content-Disposition",
        ...corsHeaders(res),
      });
      res.end(report.markdown);
    } },
  // POST /reports/run-explain/deliver
  // Body: { runId, destination: { kind, credentialName, ...kind-specific } }
  // Routes the existing run-explain report through the integration-tool
  // chokepoint (`slack.post` / `github.create_issue` / `webhook.send`).
  // Reuses every existing platform invariant — credential resolution,
  // org-scoped credential lookup, per-tool rate-limit, usage events,
  // SSRF / body-cap / timeout guards via `fetchHttpTarget`. The route's
  // own `"reports.deliver"` bucket is an additional outer gate
  // (default 60/min/org).
  //
  // Returns `{ ok, destination, statusCode?, error?, latencyMs, deliveryId? }`.
  // Failures (missing credential, rate-limit reject, upstream non-2xx,
  // network blip) NEVER throw — they return `{ ok: false, error, ... }`.
  // Generic `"credential secret missing for <credentialName>"` errors
  // from the tool chokepoint are propagated verbatim; the env-var name
  // is NEVER echoed.
  //
  // Audit row `report.run_explain.delivered` is written on BOTH success
  // AND failure (matches the AI-mutation audit posture).
  { method: "POST", match: "/reports/run-explain/deliver", role: "editor",
    handler: async ({ req, res, auth }) => {
      const rawBody = await readJson(req, 64_000);
      const parsed = deliverRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        const path = firstIssue?.path.join(".") ?? "body";
        const message = firstIssue?.message ?? "invalid body";
        return sendJson(res, { error: `Invalid request: ${path}: ${message}` }, 400);
      }

      const { runId, destination } = parsed.data;

      // Common audit metadata shape used for every terminal path. The
      // `credentialName` field is the operator-supplied identifier
      // (e.g. "ops-channel") — NOT the env-var that backs the secret.
      // safePersistPayload (called inside `audit`) catches anything
      // secret-shaped, but the route never threads the env-var name
      // into the metadata in the first place.
      type AuditFields = {
        destination: "slack" | "github" | "webhook";
        format: "markdown" | "json";
        ok: boolean;
        statusCode?: number;
        error?: string;
        latencyMs: number;
        runId: string;
        workflowId: string | null;
        workflowName: string | null;
        runStatus: string | null;
        credentialName: string;
      };

      const writeAuditRow = async (fields: AuditFields): Promise<void> => {
        await audit(auth.orgId, auth.userId, "report.run_explain.delivered", "run", runId, fields);
      };
      const auditFormat = destination.kind === "webhook" ? "json" : "markdown";

      // Outer rate-limit. Throws a status-bearing 429 on exceed; the
      // dispatcher catches HttpError, but we want to write the audit
      // row first so the bucket exercise is recorded.
      try {
        await enforceRateLimit(auth.orgId, {
          name: REPORTS_DELIVER_RATE_LIMIT_BUCKET,
          windowMs: RATE_LIMIT_WINDOW_MS,
          max: REPORTS_DELIVER_RATE_LIMIT_PER_MIN,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "rate limit exceeded";
        await writeAuditRow({
          destination: destination.kind,
          format: auditFormat,
          ok: false,
          error: "rate_limit_exceeded",
          latencyMs: 0,
          runId,
          workflowId: null,
          workflowName: null,
          runStatus: null,
          credentialName: destination.credentialName,
        });
        return sendJson(res, { error: message }, 429);
      }

      // Multi-tenant gate. A run that isn't owned by `auth.orgId`
      // returns the same 404 as a missing id — no enumeration distinction.
      const loaded = await loadRunReport({ orgId: auth.orgId, runId });
      if (!loaded) {
        return sendJson(res, { error: "Run not found" }, 404);
      }

      const inputJson = loaded.runInputJson as { workflow?: { id?: unknown } } | null;
      const workflowId = typeof inputJson?.workflow?.id === "string" ? inputJson.workflow.id : null;

      const outcome = await dispatchDelivery({
        orgId: auth.orgId,
        runId,
        destination,
        report: loaded.report,
        workflowName: loaded.workflowName,
      });

      await writeAuditRow({
        destination: destination.kind,
        format: auditFormat,
        ok: outcome.ok,
        statusCode: outcome.statusCode,
        error: outcome.error,
        latencyMs: outcome.latencyMs,
        runId,
        workflowId,
        workflowName: loaded.workflowName,
        runStatus: loaded.runStatus,
        credentialName: destination.credentialName,
      });

      return sendJson(res, {
        ok: outcome.ok,
        destination: destination.kind,
        statusCode: outcome.statusCode,
        error: outcome.error,
        latencyMs: outcome.latencyMs,
        deliveryId: outcome.deliveryId,
      });
    } },

  // GET /reports/value-dashboard?windowDays=N&format=markdown|json
  // Operator-facing MTTR + value rollup. Same data the in-app dashboard
  // renders, packaged as a downloadable artefact for sharing with a
  // stakeholder ("here's what the platform recovered for us this month").
  // Multi-tenant scoped on `auth.orgId` — no enumeration of other orgs.
  // Every export writes a `report.value_dashboard.exported` audit row.
  { method: "GET", match: (url) => url.startsWith("/reports/value-dashboard"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const rawWindow = Number.parseInt(url.searchParams.get("windowDays") ?? "", 10);
      const windowDays = Number.isFinite(rawWindow) ? Math.min(90, Math.max(1, rawWindow)) : 30;
      const formatRaw = (url.searchParams.get("format") ?? "markdown").toLowerCase();
      if (formatRaw !== "markdown" && formatRaw !== "json") {
        return sendJson(res, { error: `Unknown format: ${formatRaw}. Use "markdown" or "json".` }, 400);
      }
      const format = formatRaw as "markdown" | "json";

      const [signals, snapshot] = await Promise.all([
        collectRecoveryMetricsSignals(auth.orgId, windowDays),
        getOrgConfigSnapshot(auth.orgId),
      ]);
      const metrics = composeRecoveryMetrics(signals, windowDays, snapshot.value);

      await audit(auth.orgId, auth.userId, "report.value_dashboard.exported", "org", auth.orgId, {
        format,
        windowDays,
      });

      const { asciiFilename, utf8Filename } = buildValueDashboardFilename({
        orgId: auth.orgId,
        windowDays,
        exportedAt: new Date(),
        format,
      });

      if (format === "json") {
        const body = {
          org: {
            orgId: auth.orgId,
            exportedAt: new Date().toISOString(),
            windowDays,
          },
          metrics,
        };
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": contentDispositionAttachment(asciiFilename, utf8Filename),
          "Access-Control-Expose-Headers": "Content-Disposition",
          ...corsHeaders(res),
        });
        res.end(JSON.stringify(body));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": contentDispositionAttachment(asciiFilename, utf8Filename),
        "Access-Control-Expose-Headers": "Content-Disposition",
        ...corsHeaders(res),
      });
      res.end(buildValueDashboardMarkdown({
        orgId: auth.orgId,
        windowDays,
        metrics,
        exportedAt: new Date(),
      }));
    } },
];

/**
 * Filename builder for the value-dashboard export. Pattern:
 *   janusly-value-dashboard-<orgIdShort>-<YYYY-MM-DD>-<windowDays>d.<ext>
 *
 * Mirrors `buildReportFilename` for the run-explain report. The orgId
 * is shortened to 8 chars — operators recognise their own org without
 * needing the full UUID, and the date + window combo disambiguates the
 * same org's repeated exports.
 */
function buildValueDashboardFilename(args: {
  orgId: string;
  windowDays: number;
  exportedAt: Date;
  format: "markdown" | "json";
}): { asciiFilename: string; utf8Filename: string } {
  const orgSlug = slugify(args.orgId.slice(0, 8)) || "org";
  const datePart = args.exportedAt.toISOString().slice(0, 10);
  const ext = args.format === "json" ? "json" : "md";
  const base = `janusly-value-dashboard-${orgSlug}-${datePart}-${args.windowDays}d.${ext}`;
  return { asciiFilename: base, utf8Filename: base };
}

/**
 * Render the value-dashboard report as Markdown. Header carries the
 * "Estimate based on operator-supplied assumptions" disclaimer. The
 * assumptions section lists the three knobs the operator configured AND
 * spells the formula out plainly so a CFO reading the document knows
 * exactly how the numbers were derived. No precision claims.
 */
function buildValueDashboardMarkdown(args: {
  orgId: string;
  windowDays: number;
  metrics: RecoveryMetrics;
  exportedAt: Date;
}): string {
  const { metrics, windowDays, exportedAt } = args;
  const lines: string[] = [];
  lines.push(`# Value Dashboard — last ${windowDays} days`);
  lines.push("");
  lines.push("> **Estimate based on operator-supplied assumptions.** The numbers below ARE NOT accounting — they are projections from the assumptions the operator set in Org Config.");
  lines.push("");
  lines.push(`_Exported: ${exportedAt.toISOString()}_`);
  lines.push("");
  lines.push("## Recovery metrics");
  lines.push("");
  lines.push(`- **Success rate**: ${metrics.successRate.display} — ${metrics.successRate.rationale}`);
  lines.push(`- **MTTR (measured)**: ${metrics.mttr.display} — ${metrics.mttr.rationale}`);
  lines.push(`- **p95 latency**: ${metrics.p95Latency.display} — ${metrics.p95Latency.rationale}`);
  lines.push(`- **Approvals pending**: ${metrics.approvalsPending.display} — ${metrics.approvalsPending.rationale}`);
  lines.push(`- **Replay rate**: ${metrics.replayRate.display} — ${metrics.replayRate.rationale}`);
  lines.push(`- **AI spend**: ${metrics.costThisWindow.display} — ${metrics.costThisWindow.rationale}`);
  lines.push(`- **Clusters resolved**: ${metrics.clustersResolved.display} (${metrics.clustersResolved.totalEntries} ${metrics.clustersResolved.totalEntries === 1 ? "entry" : "entries"}${metrics.clustersResolved.capped ? "; scan was capped" : ""})`);
  lines.push("");
  lines.push("## Value estimate");
  lines.push("");
  const ve = metrics.valueEstimate;
  lines.push(`- **Hours saved (estimate)**: ${ve.hoursSaved.toFixed(2)} hours`);
  lines.push(`- **Dollars saved (estimate)**: $${ve.dollarSaved.toFixed(2)}`);
  if (ve.mttrDeltaSeconds != null) {
    const sign = ve.mttrDeltaSeconds >= 0 ? "−" : "+";
    lines.push(`- **MTTR delta vs baseline**: ${sign}${Math.abs(ve.mttrDeltaSeconds)} seconds (baseline ${ve.assumptions.baselineMttrSeconds}s)`);
  } else {
    lines.push("- **MTTR delta vs baseline**: awaiting private-beta baseline (`value.baselineMttrSeconds` is unset).");
  }
  lines.push("");
  lines.push("## Assumptions");
  lines.push("");
  lines.push(`- _Estimate based on operator-supplied assumptions._`);
  lines.push(`- Engineer hourly cost: $${ve.assumptions.hourlyCost.toFixed(2)} (USD-equivalent)`);
  lines.push(`- Minutes saved per resolved failure: ${ve.assumptions.minutesSavedPerRecovery}`);
  lines.push(`- Pre-Janusly MTTR baseline: ${ve.assumptions.baselineMttrSeconds === 0 ? "unset" : `${ve.assumptions.baselineMttrSeconds}s`}`);
  lines.push("");
  lines.push("### Formula");
  lines.push("");
  lines.push("```");
  lines.push("hoursSaved  = clustersResolved × minutesSavedPerRecovery / 60");
  lines.push("dollarSaved = hoursSaved × hourlyCost");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
