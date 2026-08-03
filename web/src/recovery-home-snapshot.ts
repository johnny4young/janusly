/** Defensive wire reader for the coalesced Recovery Center snapshot. */

export type RecoveryHomeScope = 'full' | 'impact'

export type RecoveryHomeSection =
  | { status: 'ok'; value: unknown }
  | { status: 'unavailable' }

export type RecoveryHomeSnapshot = {
  scope: RecoveryHomeScope
  generatedAt: string
  sections: Record<string, RecoveryHomeSection>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
}

export function parseRecoveryHomeSnapshot(
  value: unknown,
): RecoveryHomeSnapshot | null {
  if (!isRecord(value)) return null
  if (value.scope !== 'full' && value.scope !== 'impact') return null
  if (typeof value.generatedAt !== 'string') return null
  if (!isRecord(value.sections)) return null

  const sections: Record<string, RecoveryHomeSection> = {}
  for (const [key, candidate] of Object.entries(value.sections)) {
    if (!isRecord(candidate)) continue
    if (candidate.status === 'ok' && 'value' in candidate) {
      sections[key] = { status: 'ok', value: candidate.value }
    } else if (candidate.status === 'unavailable') {
      sections[key] = { status: 'unavailable' }
    }
  }
  return {
    scope: value.scope,
    generatedAt: value.generatedAt,
    sections,
  }
}

export function readRecoveryHomeSection<T>(
  snapshot: RecoveryHomeSnapshot,
  key: string,
  decode: (value: unknown) => T | null,
): T | null {
  const section = snapshot.sections[key]
  return section?.status === 'ok' ? decode(section.value) : null
}
