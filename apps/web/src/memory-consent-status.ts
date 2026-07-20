/** Runtime parser and pure countdown helpers for the memory governance API. */

export type MemoryPurgeStatus =
  | { status: 'none'; scheduledFor: null }
  | { status: 'scheduled'; scheduledFor: string }
  | { status: 'running'; scheduledFor: string | null }
  | { status: 'unknown'; scheduledFor: null }

export type MemoryConsentStatus = {
  enabled: boolean
  processEnabled: boolean
  tenantEnabled: boolean
  purge: MemoryPurgeStatus
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

/** Reject malformed server payloads instead of rendering a misleading consent state. */
export function parseMemoryConsentStatus(value: unknown): MemoryConsentStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.enabled !== 'boolean' ||
    typeof record.processEnabled !== 'boolean' ||
    typeof record.tenantEnabled !== 'boolean' ||
    !record.purge ||
    typeof record.purge !== 'object' ||
    Array.isArray(record.purge)
  ) return null

  const purge = record.purge as Record<string, unknown>
  const base = {
    enabled: record.enabled,
    processEnabled: record.processEnabled,
    tenantEnabled: record.tenantEnabled,
  }
  if (purge.status === 'scheduled' && isIsoDate(purge.scheduledFor)) {
    return { ...base, purge: { status: 'scheduled', scheduledFor: purge.scheduledFor } }
  }
  if (purge.status === 'running' && (purge.scheduledFor === null || isIsoDate(purge.scheduledFor))) {
    return { ...base, purge: { status: 'running', scheduledFor: purge.scheduledFor } }
  }
  if ((purge.status === 'none' || purge.status === 'unknown') && purge.scheduledFor === null) {
    return { ...base, purge: { status: purge.status, scheduledFor: null } }
  }
  return null
}

export type MemoryPurgeCountdown = { days: number; hours: number; minutes: number }

/** Whole-minute countdown, rounded up so a future purge never reads as already due. */
export function getMemoryPurgeCountdown(scheduledFor: string, nowMs: number): MemoryPurgeCountdown | null {
  const targetMs = Date.parse(scheduledFor)
  if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) return null
  let remainingMinutes = Math.max(0, Math.ceil((targetMs - nowMs) / 60_000))
  const days = Math.floor(remainingMinutes / (24 * 60))
  remainingMinutes -= days * 24 * 60
  const hours = Math.floor(remainingMinutes / 60)
  const minutes = remainingMinutes - hours * 60
  return { days, hours, minutes }
}
