/**
 * Shared download helpers for report-style routes that stream a
 * Markdown / JSON artefact as a `Content-Disposition: attachment`
 * response.
 *
 * Extracted from `routes/reports-routes.ts` so every report download
 * surface (run-explain, value-dashboard, recovery evidence export)
 * produces filenames and Content-Disposition headers with identical
 * rules — slugified, length-clamped, RFC 6266 ASCII + RFC 5987 UTF-8
 * dual form, secret-scrubbed.
 *
 * Used by:
 *  - `apps/api/src/routes/reports-routes.ts` (run-explain + value-dashboard)
 *  - `apps/api/src/routes/recovery-items-routes.ts` (evidence export)
 */

import { scrubSecretShapes } from "@janusly/shared/src/error-signature";

/** Download artefact formats the report routes support. */
export type ReportFormat = "markdown" | "json";

/**
 * Slugify a free-form string into a filesystem-safe lowercase token.
 * Keeps `[a-z0-9_-]` and collapses every other char (whitespace,
 * punctuation, non-ASCII) into a single dash. Trims leading/trailing
 * dashes and clamps length so a runaway workflow name can't blow up the
 * filename. Empty input or all-trimmed-away returns "". Runs through
 * `scrubSecretShapes` first so a secret-shaped name never leaks into a
 * filename.
 */
export function slugify(value: string, maxLen = 40): string {
  return scrubSecretShapes(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}

/**
 * Build a Content-Disposition header value that's safe in every browser.
 * Sends both `filename="<ascii>"` (RFC 6266 fallback) and
 * `filename*=UTF-8''<percent-encoded>` (RFC 5987) so non-ASCII names
 * survive on browsers that prefer the encoded form.
 */
export function contentDispositionAttachment(ascii: string, utf8: string): string {
  const encoded = encodeURIComponent(utf8);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Build the human-readable filename for a run-explain download.
 * Pattern: `janusly-<workflow_or_run>-<status>-<YYYY-MM-DD>-<short_id>.<ext>`
 *
 * UUIDs are shortened to 8 chars (long enough to disambiguate within a
 * day, short enough to fit a download history row). Non-ASCII workflow
 * names slug through to ASCII so the `filename=` ASCII fallback works;
 * the RFC 5987 `filename*=` carries the full UTF-8 form.
 */
export function buildReportFilename(args: {
  runId: string;
  workflowName: string | null;
  status: string;
  createdAt: Date | string | null;
  format: ReportFormat;
}): { asciiFilename: string; utf8Filename: string } {
  const slugSource = args.workflowName ? slugify(args.workflowName) : "";
  const namePart = slugSource || "run";
  const statusSlug = slugify(args.status) || "unknown";
  const datePart = formatDatePart(args.createdAt);
  const shortId = slugify(args.runId.slice(0, 8)) || args.runId.slice(0, 8);
  const ext = args.format === "json" ? "json" : "md";

  const base = `janusly-${namePart}-${statusSlug}-${datePart}-${shortId}.${ext}`;
  return { asciiFilename: base, utf8Filename: base };
}

/** Format a date as `YYYY-MM-DD`, or `undated` when null / unparseable. */
function formatDatePart(value: Date | string | null): string {
  if (!value) return "undated";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "undated";
  return date.toISOString().slice(0, 10);
}
