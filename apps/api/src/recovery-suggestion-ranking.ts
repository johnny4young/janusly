type ConfidenceRanked = {
  confidence?: number | null;
  approachLabel?: string | null;
};

function sortableConfidence(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type EvidencePosture = {
  preferred: ReadonlySet<string>;
  discouraged: ReadonlySet<string>;
};

const EMPTY_POSTURE: EvidencePosture = {
  preferred: new Set(),
  discouraged: new Set(),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteHttpStatus(error: unknown): number | null {
  const record = asRecord(error);
  for (const field of ["statusCode", "status"]) {
    const value = record?.[field];
    if (
      typeof value === "number"
      && Number.isInteger(value)
      && value >= 400
      && value <= 599
    ) {
      return value;
    }
  }

  const message = typeof record?.message === "string"
    ? record.message
    : typeof error === "string"
      ? error
      : "";
  const match = message.match(/\bHTTP(?:\s+failed:)?\s+([45]\d{2})\b/i);
  return match ? Number(match[1]) : null;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error.toLowerCase();
  const record = asRecord(error);
  return [
    record?.code,
    record?.name,
    record?.message,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * Convert strong runtime evidence into an ordering posture.
 *
 * The LLM may still offer alternatives, but self-rated confidence must not
 * place a causally contradicted mutation first. For example, a received HTTP
 * 503 proves that the configured URL reached an upstream; changing that URL is
 * not supported by the failure, while a bounded retry is.
 */
function evidencePosture(error: unknown): EvidencePosture {
  const status = finiteHttpStatus(error);
  const text = errorText(error);
  const timeout =
    status === 408
    || text.includes("timeout")
    || text.includes("timed out")
    || text.includes("etimedout")
    || text.includes("node_timeout");

  if (
    status === 401
    || status === 403
    || text.includes("e_secret_missing")
    || text.includes("missing secret")
  ) {
    return {
      preferred: new Set(["swap_secret_ref"]),
      discouraged: new Set(["add_retry", "fix_url", "raise_timeout"]),
    };
  }

  if (
    status === 404
    || status === 410
    || text.includes("invalid url")
    || text.includes("malformed url")
  ) {
    return {
      preferred: new Set(["fix_url"]),
      discouraged: new Set(["add_retry", "raise_timeout"]),
    };
  }

  if (timeout) {
    return {
      preferred: new Set(["raise_timeout", "add_retry"]),
      discouraged: new Set(["fix_url"]),
    };
  }

  if (
    status === 429
    || (status !== null && status >= 500)
    || text.includes("econnreset")
  ) {
    return {
      preferred: new Set(["add_retry"]),
      discouraged: new Set(["fix_url"]),
    };
  }

  return EMPTY_POSTURE;
}

function evidenceScore(
  approachLabel: string | null | undefined,
  posture: EvidencePosture,
): number {
  if (!approachLabel) return 1;
  if (posture.preferred.has(approachLabel)) return 2;
  if (posture.discouraged.has(approachLabel)) return 0;
  return 1;
}

/**
 * Return a stable evidence-first, then descending-confidence copy without
 * mutating provider output.
 *
 * When runtime evidence has no strong signal, ordering is byte-for-byte
 * compatible with the confidence-only policy. Equal scores preserve provider
 * order so deterministic fallback behavior does not depend on engine details.
 */
export function rankRecoverySuggestions<T extends ConfidenceRanked>(
  suggestions: readonly T[],
  error?: unknown,
): T[] {
  const posture = evidencePosture(error);
  return suggestions
    .map((suggestion, index) => ({ suggestion, index }))
    .sort((left, right) => {
      const evidenceDelta =
        evidenceScore(right.suggestion.approachLabel, posture) -
        evidenceScore(left.suggestion.approachLabel, posture);
      if (evidenceDelta !== 0) return evidenceDelta;

      const confidenceDelta =
        sortableConfidence(right.suggestion.confidence) -
        sortableConfidence(left.suggestion.confidence);
      return confidenceDelta !== 0
        ? confidenceDelta
        : left.index - right.index;
    })
    .map(({ suggestion }) => suggestion);
}
