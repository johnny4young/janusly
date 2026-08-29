import { OnboardingBanner } from '@janusly/web'
import { Seed } from './_stage'

/**
 * The guided-setup banner. It shows the first milestone that is not yet done
 * and a CTA that opens the panel where the operator can finish it.
 *
 * It renders nothing unless onboarding is `enabled`, `status: 'active'`, and
 * has a `currentStep` — a workspace that finished or skipped setup sees no
 * banner at all. Seeded here at step four of seven: connected, packs
 * installed, first successful run still pending.
 *
 * Store-gated, so one story — see `_stage.tsx`.
 */
export function ActiveSetup() {
  return (
    <Seed
      patch={{
        onboarding: {
          enabled: true,
          status: 'active',
          currentStep: 'first_run_succeeded',
          completed: false,
          aiAvailable: true,
          skippedAt: null,
          completedAt: null,
          milestones: [
            { step: 'org_created', done: true, order: 0, target: 'settings' },
            { step: 'credential_configured', done: true, order: 1, target: 'credentials' },
            { step: 'pack_installed', done: true, order: 2, target: 'packs' },
            { step: 'first_run_succeeded', done: false, order: 3, target: 'runs' },
            { step: 'failure_injected', done: false, order: 4, target: 'runs' },
            { step: 'recovery_applied', done: false, order: 5, target: 'recovery' },
            { step: 'completed', done: false, order: 6, target: 'workflows' },
          ],
        },
      }}
    >
      <OnboardingBanner onOpenTab={() => {}} />
    </Seed>
  )
}
