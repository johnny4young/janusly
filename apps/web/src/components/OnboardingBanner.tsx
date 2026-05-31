/**
 * "First recovered run" onboarding banner — a compact top overlay that
 * guides a new operator through the six setup milestones (configure a
 * credential → install a pack → run it → break it → recover it).
 *
 * Self-fetching: it reads `/onboarding` on mount and on every
 * `platformVersion` bump (a credential created, a pack installed, a run that
 * succeeded, a DLQ replay — every onboarding-advancing mutation bumps
 * platformVersion), stores the snapshot in the Zustand `onboarding` slot, and
 * renders only while `status === 'active'` and a next step remains. The
 * server derives progress, so it survives logout/login.
 *
 * Mounted unconditionally in `App.tsx`'s overlay layer beside
 * `BudgetBlockedBanner`; renders `null` when there's nothing to nudge.
 */

import { useEffect } from 'react'
import { ArrowRight, Check, Sparkles } from 'lucide-react'
import type { OnboardingState, OnboardingStep } from '@janusly/shared/src/onboarding'
import type { ActiveTab } from '../types'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { api } from '../api'

/**
 * Steps whose copy changes when no AI provider key is configured — both have
 * a deterministic fallback path, so the banner reassures the operator instead
 * of pointing them at an AI action that would no-op. Other steps never need
 * an AI variant.
 */
const NO_AI_STEPS: ReadonlySet<OnboardingStep> = new Set<OnboardingStep>([
  'first_run_succeeded',
  'recovery_applied',
])

export function OnboardingBanner({ onOpenTab }: { onOpenTab: (tab: ActiveTab) => void }) {
  const { t } = useT()
  // Per-step keys are built dynamically from `OnboardingStep`; the cast bridges
  // the template-literal union (which spans all steps) to the typed key set.
  const tk = (key: string): string => t(key as Parameters<typeof t>[0])
  const onboarding = useWorkflowStore((state) => state.onboarding)
  const setOnboarding = useWorkflowStore((state) => state.setOnboarding)
  const authReady = useWorkflowStore((state) => state.authReady)
  const platformVersion = useWorkflowStore((state) => state.platformVersion)

  // Derive-on-read: refetch the snapshot on boot and on any cross-panel
  // mutation. A transient failure keeps the prior state (no flicker).
  useEffect(() => {
    if (!authReady) return
    let cancelled = false
    void (async () => {
      try {
        const next = (await api('/onboarding')) as OnboardingState
        if (!cancelled) setOnboarding(next)
      } catch {
        /* offline / transient — keep the prior snapshot */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authReady, platformVersion, setOnboarding])

  if (!onboarding || !onboarding.enabled || onboarding.status !== 'active' || !onboarding.currentStep) return null

  const advanceable = onboarding.milestones.filter((m) => m.step !== 'completed')
  const doneCount = advanceable.filter((m) => m.done).length
  const total = advanceable.length
  const current = onboarding.milestones.find((m) => m.step === onboarding.currentStep)
  if (!current) return null

  const bodyKey =
    !onboarding.aiAvailable && NO_AI_STEPS.has(current.step)
      ? `onboarding.step.${current.step}.body_no_ai`
      : `onboarding.step.${current.step}.body`

  const skip = async () => {
    try {
      const next = (await api('/onboarding', {
        method: 'POST',
        body: JSON.stringify({ action: 'skip' }),
      })) as OnboardingState
      setOnboarding(next)
    } catch {
      /* offline / transient — leave the banner in place */
    }
  }

  return (
    <div className="we-onboarding-banner" role="status" data-testid="onboarding-banner">
      <span className="we-onboarding-banner__icon" aria-hidden="true">
        <Sparkles size={18} />
      </span>
      <div className="we-onboarding-banner__copy">
        <strong>{tk(`onboarding.step.${current.step}.title`)}</strong>
        <span>{tk(bodyKey)}</span>
        <ol
          className="we-onboarding-banner__dots"
          aria-label={t('onboarding.banner.progress', { done: doneCount, total })}
        >
          {advanceable.map((m) => (
            <li
              key={m.step}
              className={
                m.done
                  ? 'we-onboarding-banner__dot we-onboarding-banner__dot--done'
                  : m.step === current.step
                    ? 'we-onboarding-banner__dot we-onboarding-banner__dot--current'
                    : 'we-onboarding-banner__dot'
              }
              aria-hidden="true"
            >
              {m.done ? <Check size={11} /> : null}
            </li>
          ))}
        </ol>
      </div>
      <div className="we-onboarding-banner__actions">
        <span className="we-onboarding-banner__count">
          {t('onboarding.banner.progress', { done: doneCount, total })}
        </span>
        <button
          type="button"
          className="command-button command-button-primary"
          onClick={() => onOpenTab(current.target)}
          data-testid="onboarding-banner-cta"
        >
          {tk(`onboarding.step.${current.step}.cta`)}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="we-onboarding-banner__skip"
          onClick={() => void skip()}
          data-testid="onboarding-banner-skip"
        >
          {t('onboarding.action.skip')}
        </button>
      </div>
    </div>
  )
}
