import { Sparkles, TimerReset } from 'lucide-react'

import { useT } from '../i18n'
import type { QueueClusterGroup } from './dead-letter-model'
import { Button } from './ui/Button'

/** Cluster header in the grouped queue, at the same fixed height as a failure row. */
export function DeadLetterClusterRow({
  group,
  rowIndex,
  busy,
  disabled,
  canInvestigate,
  canReplay,
  onInvestigate,
  onReplay,
}: {
  group: QueueClusterGroup
  rowIndex: number
  busy: boolean
  disabled: boolean
  canInvestigate: boolean
  canReplay: boolean
  onInvestigate: (group: QueueClusterGroup) => void
  onReplay: (group: QueueClusterGroup) => void
}) {
  const { t } = useT()
  const { signature, category, frequency, workflowNames, rows } = group
  const hasOpenRow = rows.some((row) => row.status === 'open')
  return (
    <li className="we-list-row we-dlq-row we-dlq-cluster" role="row" aria-rowindex={rowIndex} aria-busy={busy || undefined} data-testid={`dlq-cluster-${signature}`}>
      <div className="we-list-row__body" role="gridcell">
        <strong title={signature}>{signature}</strong>
        <small title={workflowNames.join(', ')}>
          <span className="we-pill" data-tone="neutral">{t(`clusters.category.${category}`)}</span>
          {' '}{t('clusters.occurrences', { count: frequency })} · {t('clusters.workflows', { count: workflowNames.length })}
        </small>
      </div>
      <div className="we-dlq-row__recovery we-dlq-actions" role="gridcell">
        {canInvestigate && (
          <Button
            size="sm"
            disabled={disabled || !hasOpenRow}
            onClick={() => onInvestigate(group)}
            aria-label={t('dlq.cluster.investigateAria', { signature })}
            data-testid={`dlq-cluster-investigate-${signature}`}
          >
            <Sparkles size={12} aria-hidden="true" /> {t('dlq.cluster.investigate')}
          </Button>
        )}
        {canReplay && (
          <Button
            size="sm"
            disabled={disabled || !hasOpenRow || frequency < 2}
            title={frequency < 2 ? t('replayCampaign.minimumSelection') : undefined}
            onClick={() => onReplay(group)}
            aria-label={t('dlq.cluster.replayAria', { signature })}
            data-testid={`dlq-cluster-replay-${signature}`}
          >
            <TimerReset size={12} aria-hidden="true" /> {t('dlq.cluster.replay')}
          </Button>
        )}
      </div>
    </li>
  )
}
