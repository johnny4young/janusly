import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { useT } from '../../i18n'
import { describeRecoveryError } from '../../recovery-error-summary'
import { Button } from '../ui/Button'
import { StatusSummary } from '../ui/StatusSummary'

/** Collapsed JSON evidence shown under a selected failure. */
export function RecoveryDetailBlock({
  title,
  value,
  testId,
}: {
  title: string
  value: unknown
  testId?: string
}) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="detail-block">
      <Button
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(previous => !previous)}
        data-testid={testId && `${testId}-toggle`}
      >
        {t(open ? 'dlq.detail.hide' : 'dlq.detail.show', { title })}
      </Button>
      {open && <pre className="mini-pre" data-testid={testId}>{JSON.stringify(value ?? {}, null, 2)}</pre>}
    </div>
  )
}

/** Readable cause of a failure, with the raw error JSON collapsed below it. */
export function RecoveryErrorBlock({
  errorJson,
  nodeType,
}: {
  errorJson: unknown
  nodeType?: string | null
}) {
  const { t } = useT()
  const digest = describeRecoveryError(errorJson, nodeType)

  const summary = digest.dnsHost
    ? t('dlq.errorSummary.dnsHost', { host: digest.dnsHost })
    : digest.message ?? t('dlq.copy.unknownError')

  return (
    <>
      <StatusSummary
        tone="danger"
        icon={<AlertTriangle size={14} />}
        title={<span className="we-failed-node__error" data-testid="recovery-error-summary">{summary}</span>}
        description={digest.retryable !== null && (
          <div className="we-recovery-drill-context">
            {digest.category && (
              <span className="we-pill" data-tone="neutral" data-testid="recovery-error-cause">
                {t(`clusters.category.${digest.category}`)}
                {digest.causeDetail !== null && ` · ${digest.causeDetail}`}
              </span>
            )}
            <span
              className="we-pill"
              data-tone={digest.retryable ? 'success' : 'warning'}
              data-testid="recovery-error-retryable"
            >
              {t(digest.retryable ? 'dlq.errorRetry.yes' : 'dlq.errorRetry.no')}
            </span>
          </div>
        )}
      />
      <RecoveryDetailBlock title={t('dlq.detail.error')} value={errorJson} testId="recovery-error-raw" />
    </>
  )
}
