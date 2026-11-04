import { useEffect, useState } from 'react'
import { Coins } from 'lucide-react'
import { api } from '../../api'
import { useT } from '../../i18n'
import { PLATFORM_TAG, useInvalidationNonce } from '../../lib/query-cache'
import { useWorkflowStore } from '../../store'
import { requestOperationsSection } from '../operations-section-bus'
import { Button } from '../ui/Button'
import { StatusSummary } from '../ui/StatusSummary'
import { budgetBand, type BudgetEnvelope } from './recovery-center-model'
import type { ActiveTab } from '../../types'

const BUDGET_TAGS = [PLATFORM_TAG, 'billing'] as const

/** Renders nothing below the warning threshold; spend history lives in Reports. */
export function HomeBudgetBanner({ onOpenTab }: { onOpenTab: (tab: ActiveTab) => void }) {
  const { t } = useT()
  const orgId = useWorkflowStore((state) => state.orgId) ?? 'default'
  const version = useInvalidationNonce(BUDGET_TAGS)
  const [read, setRead] = useState<{ orgId: string; envelope: BudgetEnvelope | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    api('/billing/budget')
      .then((payload) => payload as BudgetEnvelope)
      .catch(() => null)
      .then((envelope) => {
        if (!cancelled) setRead({ orgId, envelope })
      })
    return () => { cancelled = true }
  }, [orgId, version])

  const envelope = read?.orgId === orgId ? read.envelope : null
  const limit = envelope?.monthlyUsdLimit
  if (!envelope?.warningThresholdCrossed || !limit) return null
  const spent = envelope.monthlyUsdSpent ?? 0

  return (
    <div data-testid="home-budget-banner">
      <StatusSummary
        role="status"
        tone={budgetBand(envelope) === 'danger' ? 'danger' : 'warning'}
        icon={<Coins size={18} />}
        title={t('recoveryCenter.budget.title')}
        description={`${t('recoveryCenter.budget.kickerUsed', { percent: ((spent / limit) * 100).toFixed(0) })} · ${t('recoveryCenter.budget.mtdValue', { spent: spent.toFixed(2), limit: limit.toFixed(2) })}`}
        actions={(
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              requestOperationsSection('ai')
              onOpenTab('operations')
            }}
            data-testid="home-budget-banner-open-settings"
          >
            {t('recoveryCenter.budget.openSettings')}
          </Button>
        )}
      />
    </div>
  )
}
