import { useEffect, useState } from 'react'
import { contractApi } from '../api'
import { useT } from '../i18n'
import { isGetWorkflowsHealthDeltaResponse } from '../lib/api-guards/operations/GetWorkflowsHealthDelta'
import { isRecoveryDelta, WORKFLOW_HEALTH_TAGS } from '../lib/health-delta'
import { useInvalidationNonce } from '../lib/query-cache'

/** Score change of the current version against the versions before it. The
 *  server decides when the sample is large enough; below that nothing renders. */
export function FlowHealthTrend({ workflowId, currentVersion }: { workflowId: string; currentVersion: number }) {
  const { t } = useT()
  const nonce = useInvalidationNonce(WORKFLOW_HEALTH_TAGS)
  const [trend, setTrend] = useState<{ version: number; points: number } | null>(null)

  useEffect(() => {
    if (currentVersion < 2) return
    const controller = new AbortController()
    const params = new URLSearchParams({ workflowId, afterVersion: String(currentVersion) })
    contractApi('GET /workflows/health/delta', `/workflows/health/delta?${params.toString()}`, undefined, {
      signal: controller.signal,
      guard: isGetWorkflowsHealthDeltaResponse,
    })
      .then((data) => {
        if (controller.signal.aborted) return
        const points = isRecoveryDelta(data, workflowId, currentVersion, null) ? data.delta?.score : undefined
        setTrend(points === undefined ? null : { version: currentVersion, points })
      })
      .catch(() => {
        if (!controller.signal.aborted) setTrend(null)
      })
    return () => controller.abort()
  }, [workflowId, currentVersion, nonce])

  if (!trend || trend.version !== currentVersion || trend.points === 0) return null
  const up = trend.points > 0
  const points = Math.abs(trend.points)
  const label = t(up ? 'workflowsDashboard.healthTrendUp' : 'workflowsDashboard.healthTrendDown', { points, version: currentVersion })
  return (
    <small role="img" aria-label={label} title={label} data-testid={`workflows-health-trend-${workflowId}`}>
      {up ? '↑' : '↓'} {points}
    </small>
  )
}
