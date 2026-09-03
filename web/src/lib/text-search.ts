export const TEXT_SEARCH_MIN_INDEXABLE_CHARACTERS = 3
export const TEXT_SEARCH_MAX_CHARACTERS = 100

export type TextSearchState =
  | { kind: 'empty' }
  | { kind: 'valid'; value: string }
  | { kind: 'too-short' }
  | { kind: 'too-long' }
  | { kind: 'invalid-characters' }

const indexableSearchRun = /[\p{L}\p{N}]{3}/u
const controlCharacter = /\p{Cc}/u

/** Mirrors the Go boundary with Unicode code points, never UTF-16 units. */
export function classifyTextSearch(input: string): TextSearchState {
  const value = input.trim()
  if (value === '') return { kind: 'empty' }

  const characters = Array.from(value)
  if (characters.length > TEXT_SEARCH_MAX_CHARACTERS) return { kind: 'too-long' }
  if (controlCharacter.test(value)) return { kind: 'invalid-characters' }
  if (!indexableSearchRun.test(value)) return { kind: 'too-short' }
  return { kind: 'valid', value }
}

/** Returns only a normalized term the server is allowed to execute. */
export function activeTextSearch(input: string): string {
  const state = classifyTextSearch(input)
  return state.kind === 'valid' ? state.value : ''
}
