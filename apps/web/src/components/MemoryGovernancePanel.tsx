/** Read-only memory consent and deletion-schedule transparency for Operations. */

import { BrainCircuit, Clock3, Database, ShieldCheck, TriangleAlert } from 'lucide-react'
import { getResolvedLocale, useT } from '../i18n'
import { useMemoryConsentStatus } from '../hooks/useMemoryConsentStatus'

export function MemoryGovernancePanel() {
  const { t } = useT()
  const { status, loading, unavailable } = useMemoryConsentStatus()

  return (
    <section
      className="we-memory-governance"
      aria-labelledby="memory-governance-heading"
      data-testid="memory-governance-panel"
    >
      <header className="we-budget-settings__header">
        <BrainCircuit size={18} aria-hidden="true" />
        <h3 id="memory-governance-heading">{t('memoryGovernance.heading')}</h3>
      </header>
      <p className="we-field__hint">{t('memoryGovernance.intro')}</p>

      {loading && !status ? (
        <p className="we-budget-settings__status" aria-live="polite">{t('memoryGovernance.loading')}</p>
      ) : unavailable || !status ? (
        <div className="we-budget-settings__error" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          {t('memoryGovernance.unavailable')}
        </div>
      ) : (
        <>
          <div className="we-memory-governance__summary" data-enabled={status.enabled ? 'true' : 'false'}>
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              <strong>{status.enabled ? t('memoryGovernance.enabled') : t('memoryGovernance.disabled')}</strong>
              <span>
                {status.enabled
                  ? t('memoryGovernance.enabledDetail')
                  : !status.processEnabled
                    ? t('memoryGovernance.processDisabledDetail')
                    : t('memoryGovernance.tenantDisabledDetail')}
              </span>
            </div>
          </div>

          <dl className="we-memory-governance__gates">
            <div>
              <dt><Database size={14} aria-hidden="true" /> {t('memoryGovernance.processGate')}</dt>
              <dd data-enabled={status.processEnabled ? 'true' : 'false'}>
                {status.processEnabled ? t('memoryGovernance.on') : t('memoryGovernance.off')}
              </dd>
            </div>
            <div>
              <dt><ShieldCheck size={14} aria-hidden="true" /> {t('memoryGovernance.tenantConsent')}</dt>
              <dd data-enabled={status.tenantEnabled ? 'true' : 'false'}>
                {status.tenantEnabled ? t('memoryGovernance.on') : t('memoryGovernance.off')}
              </dd>
            </div>
          </dl>

          <PurgeStatus status={status} />
        </>
      )}
    </section>
  )
}

function PurgeStatus({ status }: { status: NonNullable<ReturnType<typeof useMemoryConsentStatus>['status']> }) {
  const { t } = useT()
  const purge = status.purge
  if (purge.status === 'none') {
    return <p className="we-memory-governance__purge we-memory-governance__purge--clear">{t('memoryGovernance.purgeNone')}</p>
  }
  if (purge.status === 'unknown') {
    return (
      <p className="we-memory-governance__purge" role="status">
        <TriangleAlert size={15} aria-hidden="true" /> {t('memoryGovernance.purgeUnknown')}
      </p>
    )
  }
  if (purge.status === 'running') {
    return (
      <p className="we-memory-governance__purge" role="status">
        <Clock3 size={15} aria-hidden="true" /> {t('memoryGovernance.purgeRunning')}
      </p>
    )
  }
  const scheduledAt = new Date(purge.scheduledFor).toLocaleString(getResolvedLocale())
  return (
    <p className="we-memory-governance__purge" role="status">
      <Clock3 size={15} aria-hidden="true" />
      {status.tenantEnabled
        ? t('memoryGovernance.purgeScheduledSafe', { date: scheduledAt })
        : t('memoryGovernance.purgeScheduled', { date: scheduledAt })}
    </p>
  )
}
