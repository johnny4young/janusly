type ConfidenceRanked = {
  confidence?: number | null;
};

function sortableConfidence(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Return a stable, descending-confidence copy without mutating provider output.
 *
 * Equal-confidence suggestions preserve provider order so deterministic
 * fallback behavior does not depend on the JavaScript engine's sort details.
 */
export function rankRecoverySuggestions<T extends ConfidenceRanked>(
  suggestions: readonly T[],
): T[] {
  return suggestions
    .map((suggestion, index) => ({ suggestion, index }))
    .sort((left, right) => {
      const confidenceDelta =
        sortableConfidence(right.suggestion.confidence) -
        sortableConfidence(left.suggestion.confidence);
      return confidenceDelta !== 0
        ? confidenceDelta
        : left.index - right.index;
    })
    .map(({ suggestion }) => suggestion);
}
