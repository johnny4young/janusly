import { asRecord, isStringArray } from './lib/guards'
import type { Credential } from './types'

export type CredentialHealthSnapshot = {
  name: string
  secretRefPresent: boolean
  lastUsedAt: string | null
  lastErrorAt: string | null
  usageCount30d: number
  referencingWorkflowIds: string[]
  expiresAt: string | null
}

/** Null, never an empty list, when the response cannot prove who references the credential. */
export function referencingWorkflowIds(healthResponse: unknown, credentialName: string): string[] | null {
  const entries = asRecord(healthResponse)?.credentials
  const ids = Array.isArray(entries)
    ? asRecord(entries.find((entry) => entry?.name === credentialName))?.referencingWorkflowIds
    : null
  return isStringArray(ids) ? ids : null
}

export type CredentialHealthState = 'healthy' | 'warning' | 'missing' | 'unknown'

export function credentialHealthState(
  health: CredentialHealthSnapshot | undefined,
): CredentialHealthState {
  if (!health) return 'unknown'
  if (!health.secretRefPresent) return 'missing'
  if (!health.lastErrorAt) return 'healthy'

  const errorAt = new Date(health.lastErrorAt).getTime()
  const usedAt = health.lastUsedAt ? new Date(health.lastUsedAt).getTime() : Number.NaN
  if (Number.isNaN(errorAt)) return 'warning'
  return Number.isNaN(usedAt) || errorAt > usedAt ? 'warning' : 'healthy'
}

export function listCredentialKinds(credentials: readonly Credential[]): string[] {
  return Array.from(new Set(credentials.map((credential) => credential.kind))).sort((left, right) =>
    left.localeCompare(right),
  )
}

export function filterCredentials(
  credentials: readonly Credential[],
  query: string,
  kind: string,
): Credential[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return credentials.filter((credential) => {
    if (kind && credential.kind !== kind) return false
    if (!normalizedQuery) return true
    return [
      credential.name,
      credential.kind,
      credential.storage,
      credential.createdBy,
    ]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  })
}
