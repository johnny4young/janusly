/**
 * AI Studio top-of-canvas banner that surfaces a budget-block envelope
 * returned by any `/ai/*` route on HTTP 402.
 *
 * The store records the most recent 402 envelope under `budgetBlocked`
 * (set by the API wrapper in `api.ts`). When set, this banner renders
 * above the canvas with the MTD spend, the limit, and a CTA that
 * switches the active tab to Settings > AI (where
 * `BudgetSettingsPanel` lives). Dismissible via the X button, which
 * clears the store slot.
 *
 * Used by `App.tsx` — mounted unconditionally; renders null when no
 * envelope is set.
 */

import { Coins, ShieldAlert, X } from 'lucide-react'
import type { ActiveTab } from '../types'
import { useWorkflowStore } from '../store'
import { Trans, useT } from '../i18n'
import { requestOperationsSection } from './operations-section-bus'

export type BudgetBlockedEnvelope = {
  monthlyUsdSpent?: number
  monthlyUsdLimit?: number | null
  resolvedScope?: 'org' | 'workflow' | null
  exceededAt?: 'org' | 'workflow' | null
  policy?: 'warn' | 'block'
}

export function BudgetBlockedBanner({ onOpenTab }: { onOpenTab: (tab: ActiveTab) => void }) {
  const { t } = useT()
  const envelope = useWorkflowStore((state) => state.budgetBlocked)
  const clear = useWorkflowStore((state) => state.clearBudgetBlocked)

  if (!envelope) return null

  const limit = envelope.monthlyUsdLimit ?? 0
  const spent = envelope.monthlyUsdSpent ?? 0
  const scopeLabel = envelope.exceededAt === 'workflow'
    ? t('budgetBanner.scope.workflow')
    : t('budgetBanner.scope.org')

  return (
    <div className="we-budget-banner" role="alert" data-testid="budget-blocked-banner">
      <span className="we-budget-banner__icon" aria-hidden="true"><ShieldAlert size={18} /></span>
      <div className="we-budget-banner__copy">
        <strong>{t('budgetBanner.exceeded', { scope: scopeLabel })}</strong>
        <span>
          {/* Rich text lets the catalog control sentence order while mapping
              numbered placeholders to explicit safe React elements. */}
          <Trans
            i18nKey="budgetBanner.detail"
            values={{ spent: spent.toFixed(2), limit: limit.toFixed(2) }}
            components={[<strong key="spent" />, <strong key="limit" />]}
          />
        </span>
      </div>
      <div className="we-budget-banner__actions">
        <button
          type="button"
          className="command-button command-button-primary"
          onClick={() => {
            requestOperationsSection('ai')
            onOpenTab('operations')
            clear()
          }}
          data-testid="budget-blocked-banner-cta"
        >
          <Coins size={14} aria-hidden="true" />
          {t('budgetBanner.openSettings')}
        </button>
        <button
          type="button"
          className="we-budget-banner__close"
          onClick={() => clear()}
          aria-label={t('budgetBanner.dismiss')}
          data-testid="budget-blocked-banner-dismiss"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
