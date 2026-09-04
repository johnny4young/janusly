import { useEffect, useState } from 'react'
import { contractApi } from '../api'
import { parseMemoryConsentStatus, type MemoryConsentStatus } from '../memory-consent-status'
import { useWorkflowStore } from '../store'

type Snapshot = { orgId: string; value: MemoryConsentStatus }

/** Tenant-identity-safe loader shared by the Home hero and Operations Access. */
export function useMemoryConsentStatus(): {
  status: MemoryConsentStatus | null
  loading: boolean
  unavailable: boolean
} {
  const activeOrgId = useWorkflowStore((state) => state.orgId)
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const orgId = activeOrgId ?? 'default'
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [unavailableForOrg, setUnavailableForOrg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setUnavailableForOrg(null)
    contractApi('GET /memory/consent-status', '/memory/consent-status', undefined)
      .then((payload) => {
        if (cancelled) return
        const parsed = parseMemoryConsentStatus(payload)
        if (!parsed) {
          setUnavailableForOrg(orgId)
          return
        }
        setSnapshot({ orgId, value: parsed })
      })
      .catch(() => {
        if (!cancelled) setUnavailableForOrg(orgId)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [orgId, platformVersion])

  const unavailable = unavailableForOrg === orgId
  return {
    // A failed or malformed refresh must not leave the Home warning on an
    // earlier consent snapshot. Consumers can distinguish this fail-closed
    // state through `unavailable` without rendering stale governance data.
    status: unavailable ? null : snapshot?.orgId === orgId ? snapshot.value : null,
    loading,
    unavailable,
  }
}
