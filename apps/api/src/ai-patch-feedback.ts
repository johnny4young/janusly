/**
 * Composes a short, prompt-safe hint string from past
 * `recovery_feedback` rows. The output ("`add_retry` rejected 2/3 —
 * \"timeout still fires under load\"; `raise_timeout` accepted 1/1.")
 * is injected into the patch-workflow prompt's `extraContext` so the
 * LLM has soft prior on which approaches have worked for THIS workflow.
 *
 * Capped at `MAX_HINT_CHARS` (≈ 280 chars) to keep the prompt budget
 * tight — adding 280 chars to a system prompt of 8 KB is a rounding
 * error, but uncapped a noisy workflow's history could blow past that.
 *
 * Used by:
 * - `apps/api/src/routes/ai-routes.ts:POST /ai/patch-workflow` — the route calls
 *   `summarizePastFeedback` then passes the result through this helper
 *   before threading the string into `extraContext.pastFeedbackSummary`.
 *
 * Pure function — no I/O, no DB access. Defense-in-depth: re-runs the
 * shared `scrubSecretShapes` over each rejection comment in case
 * something slipped past the write-side scrub in `recoveryFeedbackRepo`.
 */

import { z } from "zod";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import {
  type FeedbackSummary,
} from "@janusly/data";

/**
 * Zod body schema for `POST /recovery/feedback`. Closed enums match
 * the patch envelope's `approachLabel` set + the AI fallback contract's
 * `suggestionMode`. The 2000-char `comment` cap mirrors the
 * `COMMENT_MAX_LENGTH` belt-and-braces ceiling in the repo (the repo
 * trims to the same value at write time).
 */
export const RecoveryFeedbackBodySchema = z.object({
  deadLetterId: z.string().min(1).max(256),
  suggestionMode: z.enum(["ai", "fallback"]),
  approachLabel: z.enum([
    "add_retry",
    "raise_timeout",
    "swap_secret_ref",
    "add_approval",
    "fix_url",
    "other",
  ]),
  accepted: z.boolean(),
  comment: z.string().max(2000).optional(),
  // Operator opt-in to reuse this decision as eval-dataset training
  // material. Optional + defaults to `false` server-side — a row is
  // never eligible for an eval example without explicit consent. Only
  // meaningful on `accepted: true` rows (the dataset build filters
  // accepted), but stored verbatim so a future rejection-capture
  // dataset is a one-line change.
  evalConsent: z.boolean().optional(),
  // Optional LLM rationale text for the accepted suggestion. The
  // recovery dialog passes it on the apply-success path so the route
  // can synthesize a `patch_rationale` memory entry alongside the
  // `recovery_rationale` it already writes. Cancel / iterate paths
  // omit it; headless callers (MCP, CI) also omit it and consequently
  // never seed the `patch_rationale` substrate. 2000-char cap mirrors
  // `comment`'s DoS bound and matches the upstream-suggested rationale
  // size from the patch envelope.
  rationale: z.string().max(2000).optional(),
  // The model's raw self-rated confidence (0-100) for the decided-on
  // suggestion. Persisted on the `recovery_feedback` row so the daily
  // confidence-calibration sweep can bucket decisions by raw confidence
  // and fit the per-approach linear curve. Optional + integer-bounded;
  // headless callers omit it (those rows drop out of the calibration fit
  // via the repo's `raw_confidence IS NOT NULL` filter).
  rawConfidence: z.number().int().min(0).max(100).optional(),
});

/** Max characters in the produced hint string. Truncated with a trailing `…` if exceeded. */
export const MAX_HINT_CHARS = 280;

/** Max chars per quoted rejection comment. Long comments get truncated before being inlined. */
const MAX_COMMENT_CHARS = 60;

/**
 * Build a single-line hint from the per-approach summary. Returns `""`
 * for an empty summary so first-time recoveries leave the prompt
 * unchanged (no enrichment line, no shape drift).
 */
export function composeFeedbackHint(summary: FeedbackSummary[]): string {
  if (!summary || summary.length === 0) return "";

  const segments: string[] = [];
  for (const bucket of summary) {
    const total = bucket.acceptedCount + bucket.rejectedCount;
    if (total === 0) continue;
    let segment = `${bucket.approachLabel} accepted ${bucket.acceptedCount}/${total}`;
    // Inline at most one rejection comment per approach, scrubbed
    // again for token-shape substrings (defense in depth).
    if (bucket.rejectedCount > 0 && bucket.rejectionComments.length > 0) {
      const reason = scrubSecretShapes(bucket.rejectionComments[0]!);
      const trimmed = reason.length > MAX_COMMENT_CHARS
        ? `${reason.slice(0, MAX_COMMENT_CHARS - 1).trimEnd()}…`
        : reason;
      segment += ` ("${trimmed}")`;
    }
    segments.push(segment);
  }

  if (segments.length === 0) return "";
  const joined = `Past operator decisions for this workflow: ${segments.join("; ")}.`;
  if (joined.length <= MAX_HINT_CHARS) return joined;
  return `${joined.slice(0, MAX_HINT_CHARS - 1).trimEnd()}…`;
}

// ─── Memory write helpers (consumed by /recovery/feedback) ─────────────────

/** Hard cap on the rationale text inlined into the patch_rationale memory
 *  content. The schema already caps at 2000; this is the per-line ceiling
 *  before the embedding model gets the string. Long rationales get a
 *  trailing `…`. */
const MAX_RATIONALE_CHARS = 1_200;

/** Hard cap on the failure signature segment in recovery_rationale content. */
const MAX_SIGNATURE_CHARS = 120;

/**
 * Compose the `content` string for a `recovery_rationale` memory entry.
 *
 * The string is the durable record of one operator decision — what
 * approach the LLM proposed (`approachLabel`), whether the operator
 * accepted, the failure signature so the embedding model can match
 * future failures with similar shapes, and the operator's optional
 * comment. Re-scrubs via `scrubSecretShapes` even though the comment
 * already passed write-time scrubbing in the feedback repo, because
 * defense-in-depth before the embedding call is cheap and the signature
 * could carry a fresh shape that wasn't in the regex at write time.
 *
 * Pure-functional so the test suite can pin the exact output.
 */
export function composeRecoveryRationaleContent(input: {
  approachLabel: string;
  accepted: boolean;
  comment: string | null | undefined;
  signature: string;
}): string {
  const verdict = input.accepted ? "operator accepted" : "operator rejected";
  const scrubbedSignature = scrubSecretShapes(input.signature);
  const signature = scrubbedSignature.length > MAX_SIGNATURE_CHARS
    ? `${scrubbedSignature.slice(0, MAX_SIGNATURE_CHARS - 1).trimEnd()}…`
    : scrubbedSignature;
  const rawComment = input.comment?.trim();
  let commentSegment = "(none)";
  if (rawComment) {
    const scrubbedComment = scrubSecretShapes(rawComment);
    commentSegment = scrubbedComment.length > MAX_COMMENT_CHARS
      ? `${scrubbedComment.slice(0, MAX_COMMENT_CHARS - 1).trimEnd()}…`
      : scrubbedComment;
  }
  return (
    `approachLabel=${input.approachLabel} — ${verdict}. ` +
    `Failure signature: ${signature}. ` +
    `Comment: ${commentSegment}`
  );
}

/**
 * Compose the `content` string for a `patch_rationale` memory entry.
 *
 * The LLM's own rationale text for an ACCEPTED suggestion. Used by the
 * read-side (recall) so a future similar failure can recall the
 * explanation the LLM gave in a past success, not just the
 * approachLabel. Scrubbed + per-line bounded.
 *
 * Pure-functional.
 */
export function composePatchRationaleContent(input: {
  approachLabel: string;
  rationale: string;
}): string {
  const scrubbed = scrubSecretShapes(input.rationale.trim());
  const trimmed = scrubbed.length > MAX_RATIONALE_CHARS
    ? `${scrubbed.slice(0, MAX_RATIONALE_CHARS - 1).trimEnd()}…`
    : scrubbed;
  return `approachLabel=${input.approachLabel}. Rationale: ${trimmed}`;
}
