import { useEffect, useState } from 'react'
import { api } from '../api'
import { isRecord } from '../lib/guards'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import { useWorkflowStore } from '../store'

const COUNT_TAGS = [PLATFORM_TAG, 'org-config', 'dlq', 'recovery'] as const

// Each read sits behind the same permission as the panel that owns the data.
const LIST_READS = {
  alertPolicies: ['alerts.read', '/alerts/policies', 'policies'],
  failurePatterns: ['dlq.read', '/dlq/clusters', 'clusters'],
  roles: ['members.read', '/org/roles', 'roles'],
  credentials: ['credentials.read', '/credentials', null],
  mcpConnections: ['mcp.connections.read', '/mcp/connections', 'connections'],
} as const

export type SettingsAreaCounts = Partial<Record<keyof typeof LIST_READS, number>> & { mfaRequired?: boolean }

const NOT_READ: SettingsAreaCounts = {}

/** Counts for the index cards, read only while the index is open. A denied or
 *  failed read leaves its count undefined. */
export function useSettingsAreaCounts(permissions: readonly string[] | undefined): SettingsAreaCounts {
  const orgId = useWorkflowStore((state) => state.orgId)
  const version = useInvalidationNonce(COUNT_TAGS)
  const [snapshot, setSnapshot] = useState<{ orgId: typeof orgId; counts: SettingsAreaCounts } | null>(null)

  useEffect(() => {
    let cancelled = false
    const counts: SettingsAreaCounts = {}
    const read = (permission: string, path: string, apply: (body: unknown) => void) => (
      permissions === undefined || permissions.includes(permission)
        ? api(path).then(apply).catch(() => undefined)
        : undefined
    )
    void Promise.all([
      ...Object.entries(LIST_READS).map(([key, [permission, path, field]]) =>
        read(permission, path, (body) => {
          const list = field && isRecord(body) ? body[field] : body
          if (Array.isArray(list)) counts[key as keyof typeof LIST_READS] = list.length
        })),
      // An unset key is the default (not required); a payload with no list says nothing.
      read('org.config.write', '/org/config', (body) => {
        if (!isRecord(body) || !Array.isArray(body.config)) return
        counts.mfaRequired = body.config.some((entry) =>
          isRecord(entry) && entry.key === 'auth.mfaRequired' && entry.value === true)
      }),
    ]).then(() => {
      if (!cancelled) setSnapshot({ orgId, counts })
    })
    return () => { cancelled = true }
  }, [orgId, permissions, version])

  return snapshot?.orgId === orgId ? snapshot.counts : NOT_READ
}
