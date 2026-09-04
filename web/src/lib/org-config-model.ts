/**
 * The org-config read as the API serves it. Four panels used to declare
 * their own `OrgConfigEntry` and parse the `/org/config` payload four
 * different ways (two of them with dead branches for shapes the endpoint
 * never returns); they now share this model.
 */

import { isRecord } from './guards'

export type OrgConfigEntry = {
  key: string
  value: string | number | boolean
  source?: string
  description?: string
}

/**
 * The entries of an `/org/config` payload: the endpoint answers
 * `{ config: OrgConfigEntry[] }`, and a bare array is accepted for the
 * older wire shape. Anything else reads as no entries.
 */
export function parseOrgConfigEntries(payload: unknown): OrgConfigEntry[] {
  const raw = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.config) ? payload.config : []
  return raw.filter((entry): entry is OrgConfigEntry =>
    isRecord(entry) && typeof entry.key === 'string'
      && (typeof entry.value === 'string' || typeof entry.value === 'number' || typeof entry.value === 'boolean'))
}

/** The value of one key, or undefined when the payload does not carry it. */
export function orgConfigValue(payload: unknown, key: string): OrgConfigEntry['value'] | undefined {
  return parseOrgConfigEntries(payload).find((entry) => entry.key === key)?.value
}
