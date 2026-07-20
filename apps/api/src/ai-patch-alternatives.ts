/** Bounded read-side sanitizer for model-authored patch alternatives. */

import { scrubOperatorGuidanceSecrets } from "@janusly/shared";

export type ConsideredAlternative = {
  approach: string;
  rejectedBecause: string;
};

const CONTROL_OR_INVISIBLE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gi;

function oneLine(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return scrubOperatorGuidanceSecrets(value)
    .replace(CONTROL_OR_INVISIBLE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/** Keep at most two complete, non-empty summaries. */
export function sanitizeConsideredAlternatives(value: unknown): ConsideredAlternative[] {
  if (!Array.isArray(value)) return [];
  const out: ConsideredAlternative[] = [];
  for (const item of value) {
    if (out.length >= 2) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const approach = oneLine(record.approach, 120);
    const rejectedBecause = oneLine(record.rejectedBecause, 280);
    if (!approach || !rejectedBecause) continue;
    out.push({ approach, rejectedBecause });
  }
  return out;
}
