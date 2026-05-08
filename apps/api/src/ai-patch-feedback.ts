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
 * - `apps/api/src/index.ts:POST /ai/patch-workflow` — the route calls
 *   `summarizePastFeedback` then passes the result through this helper
 *   before threading the string into `extraContext.pastFeedbackSummary`.
 *
 * Pure function — no I/O, no DB access. Defense-in-depth: re-runs the
 * shared `scrubSecretShapes` over each rejection comment in case
 * something slipped past the write-side scrub in `recoveryFeedbackRepo`.
 */

import { z } from "zod";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import type { FeedbackSummary } from "@janusly/data/src/recoveryFeedbackRepo";

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
