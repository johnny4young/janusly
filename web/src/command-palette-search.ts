/**
 * Dependency-free fuzzy ranking for the command palette.
 *
 * Used by:
 * - `apps/web/src/components/CommandPalette.tsx`
 *
 * Exact substrings always outrank subsequence matches. Fuzzy matches reward a
 * compact span and penalize leading distance so short, memorable queries stay
 * useful even when the palette contains many saved workflows.
 */

export type PaletteSearchCandidate<T> = {
  item: T
  label: string
  keywords?: string[]
}

function normalize(value: string): string {
  return value
    .trim()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

type PaletteMatch = {
  kind: 'exact' | 'fuzzy'
  score: number
}

function evaluatePaletteMatch(query: string, candidate: string): PaletteMatch | null {
  const needle = normalize(query)
  const haystack = normalize(candidate)
  if (!needle) return { kind: 'exact', score: 0 }
  if (!haystack) return null

  const exactIndex = haystack.indexOf(needle)
  if (exactIndex >= 0) {
    return {
      kind: 'exact',
      score: -(exactIndex * 10 + Math.max(0, haystack.length - needle.length)),
    }
  }

  let needleIndex = 0
  let firstMatch = -1
  let lastMatch = -1
  let adjacencyBonus = 0

  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[needleIndex]) continue
    if (firstMatch < 0) firstMatch = index
    if (lastMatch === index - 1) adjacencyBonus += 4
    lastMatch = index
    needleIndex += 1
  }

  if (needleIndex !== needle.length || firstMatch < 0 || lastMatch < 0) return null

  const spanGap = lastMatch - firstMatch + 1 - needle.length
  return {
    kind: 'fuzzy',
    score: -(spanGap * 12 + firstMatch * 3 + haystack.length) + adjacencyBonus,
  }
}

/**
 * Score one candidate against a query. Higher is better; `null` means the
 * query is not a subsequence of the candidate.
 */
export function scorePaletteMatch(query: string, candidate: string): number | null {
  const match = evaluatePaletteMatch(query, candidate)
  if (!match) return null
  return match.kind === 'exact' ? Number.MAX_SAFE_INTEGER + match.score : match.score
}

/** Rank matching candidates stably and return only the strongest results. */
export function rankPaletteMatches<T>(
  query: string,
  candidates: Array<PaletteSearchCandidate<T>>,
  limit = 5,
): T[] {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return candidates.map(({ item }) => item)

  return candidates
    .map((candidate, index) => {
      const matches = [candidate.label, ...(candidate.keywords ?? [])]
        .map((value) => evaluatePaletteMatch(normalizedQuery, value))
        .filter((match): match is PaletteMatch => match !== null)
      const strongest = matches.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'exact' ? -1 : 1
        return b.score - a.score
      })[0] ?? null
      return {
        item: candidate.item,
        index,
        kind: strongest?.kind ?? null,
        score: strongest?.score ?? null,
      }
    })
    .filter((entry): entry is { item: T; index: number; kind: PaletteMatch['kind']; score: number } => (
      entry.kind !== null && entry.score !== null
    ))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'exact' ? -1 : 1
      return b.score - a.score || a.index - b.index
    })
    .slice(0, Math.max(0, limit))
    .map(({ item }) => item)
}
