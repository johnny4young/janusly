/**
 * Glob matcher for `AlertParamsDlqEntryCreated.errorSignaturePattern` — only
 * supports `*` (any run of characters, including empty) and `?` (any single
 * character). NOT a regex: no character classes, no alternation, no nested
 * patterns. The matcher is a deterministic two-pointer algorithm with `*`
 * backtracking — O(pattern_len × value_len) worst case, no exponential
 * blowup. Combined with the Zod-enforced 200-char pattern cap and the
 * `normalizeErrorSignature` bounded output, there is no ReDoS surface.
 *
 * Used by the alert dispatcher to filter `dlq.entry_created` events against
 * the operator-declared pattern.
 */

/** Match a glob pattern (`*`, `?` are wildcards) against a literal value. */
export function matchGlob(pattern: string, value: string): boolean {
  let p = 0
  let v = 0
  let starP = -1
  let starV = -1

  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === value[v])) {
      p++
      v++
      continue
    }
    if (p < pattern.length && pattern[p] === '*') {
      starP = p
      starV = v
      p++
      continue
    }
    if (starP !== -1) {
      p = starP + 1
      starV++
      v = starV
      continue
    }
    return false
  }

  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}
