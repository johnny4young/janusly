import { describe, expect, it } from 'vitest'

import {
  credentialHealthState,
  filterCredentials,
  knownWorkflowReferences,
  listCredentialKinds,
  referencingWorkflowIds,
  summarizeCredentialHealth,
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

describe('summarizeCredentialHealth', () => {
  const nowMs = Date.parse('2026-07-29T00:00:00.000Z')
  const at = (days: number) => new Date(nowMs + days * 86_400_000).toISOString()
  const summarize = (entry: Partial<CredentialHealthSnapshot> | null, expiresAt?: string) => summarizeCredentialHealth(
    [{ ...credentials[0]!, expiresAt }],
    new Map(entry ? [['pagerduty-primary', health({ usageCount30d: 1, ...entry })]] : []),
    nowMs,
  )

  it('counts expired and soon-to-expire connections, not distant ones', () => {
    expect(summarize({ expiresAt: at(-1) }).expiring).toBe(1)
    expect(summarize({ expiresAt: at(14) }).expiring).toBe(1)
    expect(summarize({ expiresAt: at(15) }).expiring).toBe(0)
    expect(summarize({ expiresAt: null }).expiring).toBe(0)
    expect(summarize(null, at(1)).expiring).toBe(1)
  })

  it('counts unresolved errors and missing secrets, not recovered ones', () => {
    expect(summarize({ lastErrorAt: at(-1), lastUsedAt: at(-2) }).errors).toBe(1)
    expect(summarize({ secretRefPresent: false }).errors).toBe(1)
    expect(summarize({ lastErrorAt: at(-2), lastUsedAt: at(-1) }).errors).toBe(0)
    expect(summarize(null).errors).toBe(0)
  })

  it('calls a connection unused only when nothing proves otherwise', () => {
    expect(summarize({ usageCount30d: 0 }).unused).toBe(1)
    expect(summarize({ usageCount30d: 2 }).unused).toBe(0)
    expect(summarize({ usageCount30d: 0, referencingWorkflowIds: ['wf-1'] }).unused).toBe(0)
    expect(summarize(null).unused).toBe(0)
    const malformed = { usageCount30d: 0, referencingWorkflowIds: undefined as unknown as string[] }
    expect(summarize(malformed).unused).toBe(0)
    expect(knownWorkflowReferences(health(malformed))).toBeNull()
    expect(knownWorkflowReferences(undefined)).toBeNull()
  })
})

describe('referencingWorkflowIds', () => {
  it('returns the references of the named credential, including an empty list', () => {
    const response = {
      credentials: [
        { name: 'other', referencingWorkflowIds: ['wf-other'] },
        { name: 'used', referencingWorkflowIds: ['wf-1', 'wf-2'] },
        { name: 'unused', referencingWorkflowIds: [] },
      ],
    }
    expect(referencingWorkflowIds(response, 'used')).toEqual(['wf-1', 'wf-2'])
    expect(referencingWorkflowIds(response, 'unused')).toEqual([])
  })

  it.each([
    [null],
    ['nope'],
    [{}],
    [{ credentials: 'nope' }],
    [{ credentials: [null, 'x'] }],
    [{ credentials: [{ name: 'other', referencingWorkflowIds: [] }] }],
    [{ credentials: [{ name: 'used' }] }],
    [{ credentials: [{ name: 'used', referencingWorkflowIds: [1] }] }],
  ])('never turns an unproven response into an empty list: %j', (response) => {
    expect(referencingWorkflowIds(response, 'used')).toBeNull()
  })
})
