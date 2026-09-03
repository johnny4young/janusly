/**
 * "Replay onboarding" control for the Recovery Center home.
 *
 * The onboarding banner (`OnboardingBanner`) hides once onboarding is
 * completed or skipped, so this is the deliberate entry point to run the
 * guided checklist again on the same tenant. It reads the shared `onboarding`
 * store slot the banner already populates (no extra fetch), and renders ONLY
 * when onboarding is out of the way (completed / skipped) AND the tenant
 * toggle is on — while onboarding is active the banner itself is showing, so
 * a replay control would be redundant.
 *
 * On click it resumes skipped onboarding (preserving partial progress) or
 * restarts completed onboarding (stamping the server-side restart epoch so
 * milestone derivation re-windows to post-restart activity), then bumps
 * `platformVersion` so the global banner re-fetches and re-appears.
 */

import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { OnboardingState } from '@/lib/onboarding'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { api } from '../api'

export function OnboardingReplayButton() {
  const { t } = useT()
  const onboarding = useWorkflowStore((state) => state.onboarding)
  const setOnboarding = useWorkflowStore((state) => state.setOnboarding)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [busy, setBusy] = useState(false)

  if (!onboarding?.enabled) return null
  if (onboarding.status !== 'completed' && onboarding.status !== 'skipped') return null

  const replay = async () => {
    const action = onboarding.status === 'skipped' ? 'resume' : 'restart'
    setBusy(true)
    try {
      const next = (await api('/onboarding', {
        method: 'POST',
        body: JSON.stringify({ action }),
      })) as OnboardingState
      setOnboarding(next)
      bumpPlatformVersion() // the global banner re-fetches + re-appears from step one
      addToast(t(action === 'resume' ? 'onboarding.replay.resumeToast' : 'onboarding.replay.toast'), 'success')
    } catch {
      addToast(t('onboarding.replay.failed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="we-onboarding-replay">
      <button
        type="button"
        className="we-onboarding-replay__button"
        onClick={() => void replay()}
        disabled={busy}
        data-testid="onboarding-replay"
      >
        <RotateCcw size={14} aria-hidden="true" />
        {t(onboarding.status === 'skipped' ? 'onboarding.replay.resumeCta' : 'onboarding.replay.cta')}
      </button>
    </div>
  )
}
