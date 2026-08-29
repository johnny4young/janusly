import { OnboardingReplayButton } from '@janusly/web'
import { Seed } from './_stage'

/**
 * The way back into guided setup. It is the mirror image of
 * `OnboardingBanner`: that one shows while setup is `active`, this one appears
 * only once onboarding has been `completed` or `skipped`, so the two are never
 * on screen together.
 *
 * Store-gated, so one story — see `_stage.tsx`.
 */
export function AfterCompletion() {
  return (
    <Seed
      patch={{
        onboarding: {
          enabled: true,
          status: 'completed',
          currentStep: null,
          completed: true,
          aiAvailable: true,
          skippedAt: null,
          completedAt: '2026-08-20T16:12:00.000Z',
          milestones: [
            { step: 'org_created', done: true, order: 0, target: 'settings' },
            { step: 'credential_configured', done: true, order: 1, target: 'credentials' },
            { step: 'pack_installed', done: true, order: 2, target: 'packs' },
            { step: 'first_run_succeeded', done: true, order: 3, target: 'runs' },
            { step: 'failure_injected', done: true, order: 4, target: 'runs' },
            { step: 'recovery_applied', done: true, order: 5, target: 'recovery' },
            { step: 'completed', done: true, order: 6, target: 'workflows' },
          ],
        },
      }}
    >
      <OnboardingReplayButton />
    </Seed>
  )
}
