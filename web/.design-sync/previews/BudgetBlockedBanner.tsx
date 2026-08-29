import { BudgetBlockedBanner } from '@janusly/web'
import { Seed, Stage } from './_stage'

/**
 * The banner AI Studio shows above the canvas once the workspace has hit its
 * monthly AI budget. It reads the most recent `402` envelope from the store —
 * nothing renders until one is recorded, which is why the preview seeds it.
 *
 * `policy` is the whole point: `block` means generation is refused, `warn`
 * means it still runs and this is a heads-up. `exceededAt` says which limit
 * tripped, so an operator knows whether to raise the org cap or the workflow's.
 *
 * The banner is `position: fixed; top: 72px` and centred on its containing
 * block, so it needs a cell tall enough to clear that offset — otherwise it
 * lands above the visible area.
 *
 * Store-gated, so one story — see `_stage.tsx` on why cells share a store.
 */
export function OrgBudgetBlocked() {
  return (
    <Seed
      patch={{
        budgetBlocked: {
          monthlyUsdSpent: 250,
          monthlyUsdLimit: 250,
          resolvedScope: 'org',
          exceededAt: 'org',
          policy: 'block',
        },
      }}
    >
      <Stage minHeight={300}>
        <BudgetBlockedBanner onOpenTab={() => {}} />
      </Stage>
    </Seed>
  )
}
