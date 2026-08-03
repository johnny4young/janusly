import { lazy, Suspense, useId, useState } from 'react'
import { ChevronDown, Network } from 'lucide-react'

import { useT } from '../i18n'

const FailureClustersCard = lazy(() => import('./FailureClustersCard').then((module) => ({
  default: module.FailureClustersCard,
})))
const ReplayCampaignsCard = lazy(() => import('./ReplayCampaignsCard').then((module) => ({
  default: module.ReplayCampaignsCard,
})))
const AutoHealingPendingCard = lazy(() => import('./AutoHealingPendingCard').then((module) => ({
  default: module.AutoHealingPendingCard,
})))

type RecoveryAutomationDisclosureProps = {
  canRecover: boolean
  canCancelCampaign: boolean
  canReadAutoHealing: boolean
  canDecideAutoHealing: boolean
}

/**
 * Defers supplementary recovery analysis until the operator asks for it.
 * Keeping the children unmounted also postpones their API reads and polling.
 */
export function RecoveryAutomationDisclosure({
  canRecover,
  canCancelCampaign,
  canReadAutoHealing,
  canDecideAutoHealing,
}: RecoveryAutomationDisclosureProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const contentId = useId()

  return (
    <section
      className="we-card we-recovery-automation"
      data-open={open ? 'true' : 'false'}
      data-testid="recovery-automation"
    >
      <button
        type="button"
        className="we-recovery-automation__toggle"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        data-testid="recovery-automation-toggle"
      >
        <span className="we-recovery-automation__icon" aria-hidden="true">
          <Network size={17} />
        </span>
        <span className="we-recovery-automation__copy">
          <strong>{t('dlq.automation.title')}</strong>
          <small>{t('dlq.automation.description')}</small>
        </span>
        <ChevronDown className="we-recovery-automation__chevron" size={17} aria-hidden="true" />
      </button>

      {open && (
        <div id={contentId} className="we-recovery-automation__content">
          <Suspense fallback={<p className="helper-text">{t('dlq.automation.loading')}</p>}>
            <FailureClustersCard canRecover={canRecover} />
            <ReplayCampaignsCard canCancel={canCancelCampaign} />
            {canReadAutoHealing && <AutoHealingPendingCard canDecide={canDecideAutoHealing} />}
          </Suspense>
        </div>
      )}
    </section>
  )
}
