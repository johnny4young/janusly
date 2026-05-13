/**
 * AI Studio top-of-canvas banner that surfaces a budget-block envelope
 * returned by any `/ai/*` route on HTTP 402.
 *
 * The store records the most recent 402 envelope under `budgetBlocked`
 * (set by the API wrapper in `api.ts`). When set, this banner renders
 * above the canvas with the MTD spend, the limit, and a CTA that
 * switches the active tab to `operations` (where `BudgetSettingsPanel`
 * lives). Dismissible via the X button, which clears the store slot.
 *
 * Used by `App.tsx` — mounted unconditionally; renders null when no
 * envelope is set.
 */

import React from 'react'
import { Coins, ShieldAlert, X } from 'lucide-react'
import type { ActiveTab } from '../types'
import { useWorkflowStore } from '../store'

export type BudgetBlockedEnvelope = {
  monthlyUsdSpent?: number
  monthlyUsdLimit?: number | null
  resolvedScope?: 'org' | 'workflow' | null
  exceededAt?: 'org' | 'workflow' | null
  policy?: 'warn' | 'block'
}

export function BudgetBlockedBanner({ onOpenTab }: { onOpenTab: (tab: ActiveTab) => void }) {
  const envelope = useWorkflowStore((state) => state.budgetBlocked)
  const clear = useWorkflowStore((state) => state.clearBudgetBlocked)

  if (!envelope) return null

  const limit = envelope.monthlyUsdLimit ?? 0
  const spent = envelope.monthlyUsdSpent ?? 0
  const scopeLabel = envelope.exceededAt === 'workflow' ? 'workflow' : 'org'

  return (
    <div className="we-budget-banner" role="alert" data-testid="budget-blocked-banner">
      <span className="we-budget-banner__icon" aria-hidden="true"><ShieldAlert size={18} /></span>
      <div className="we-budget-banner__copy">
        <strong>AI {scopeLabel} budget exceeded — call blocked.</strong>
        <span>
          You've spent <strong>${spent.toFixed(2)}</strong> of the <strong>${limit.toFixed(2)}</strong> monthly limit.
          Raise the budget in Operations or change the policy to warn only to keep AI calls running.
        </span>
      </div>
      <div className="we-budget-banner__actions">
        <button
          type="button"
          className="command-button command-button-primary"
          onClick={() => {
            onOpenTab('operations')
            clear()
          }}
          data-testid="budget-blocked-banner-cta"
        >
          <Coins size={14} aria-hidden="true" />
          Open budget settings
        </button>
        <button
          type="button"
          className="we-budget-banner__close"
          onClick={() => clear()}
          aria-label="Dismiss budget banner"
          data-testid="budget-blocked-banner-dismiss"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
