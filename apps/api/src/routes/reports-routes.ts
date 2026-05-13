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

import { auditLogs, db, runEvents, runNodes, runs } from "@janusly/db";
import { buildRunExplainReport } from "@janusly/engine/src/run-explain-report";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";

import { audit } from "../audit";
import { corsHeaders, sendJson } from "../http";
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
];
