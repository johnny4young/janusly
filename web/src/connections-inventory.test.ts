import { describe, expect, it } from 'vitest'

import {
  credentialHealthState,
  filterCredentials,
  listCredentialKinds,
  type CredentialHealthSnapshot,
} from './connections-inventory'
import type { Credential } from './types'

const credentials: Credential[] = [
  {
    id: '1',
    name: 'pagerduty-primary',
    kind: 'pagerduty_api_token',
    storage: 'managed',
    createdBy: 'operator@example.com',
  },
  {
    id: '2',
    name: 'support-slack',
    kind: 'slack_webhook',
    storage: 'environment',
    createdBy: 'platform@example.com',
  },
  {
    id: '3',
    name: 'billing-db',
    kind: 'postgres',
    storage: 'managed',
  },
]

function health(overrides: Partial<CredentialHealthSnapshot> = {}): CredentialHealthSnapshot {
  return {
    name: 'pagerduty-primary',
    secretRefPresent: true,
    lastUsedAt: null,
    lastErrorAt: null,
    usageCount30d: 0,
    referencingWorkflowIds: [],
    expiresAt: null,
    ...overrides,
  }
}

describe('connections inventory model', () => {
  it('searches by name, type, storage, and owner while composing the type filter', () => {
    expect(filterCredentials(credentials, 'operator@', '')).toEqual([credentials[0]])
    expect(filterCredentials(credentials, 'environment', '')).toEqual([credentials[1]])
    expect(filterCredentials(credentials, '', 'postgres')).toEqual([credentials[2]])
    expect(filterCredentials(credentials, 'support', 'postgres')).toEqual([])
  })

  it('returns a stable sorted kind list', () => {
    expect(listCredentialKinds(credentials)).toEqual([
      'pagerduty_api_token',
      'postgres',
      'slack_webhook',
    ])
  })

  it('distinguishes missing, unresolved, recovered, and recent-error health', () => {
    expect(credentialHealthState(undefined)).toBe('unknown')
    expect(credentialHealthState(health({ secretRefPresent: false }))).toBe('missing')
    expect(credentialHealthState(health({
      lastErrorAt: '2026-07-29T10:00:00.000Z',
      lastUsedAt: '2026-07-29T09:00:00.000Z',
    }))).toBe('warning')
    expect(credentialHealthState(health({
      lastErrorAt: '2026-07-29T09:00:00.000Z',
      lastUsedAt: '2026-07-29T10:00:00.000Z',
    }))).toBe('healthy')
    expect(credentialHealthState(health({
      lastErrorAt: 'not-a-date',
      lastUsedAt: '2026-07-29T10:00:00.000Z',
    }))).toBe('warning')
  })
})
