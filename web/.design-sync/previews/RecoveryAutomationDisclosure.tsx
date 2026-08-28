import { RecoveryAutomationDisclosure } from '@janusly/web'

/**
 * States plainly what the current operator is allowed to do with recovery
 * automation, so nobody has to infer their permissions from which buttons
 * happen to be disabled. Each flag maps to one disclosed capability.
 *
 * **Why this card shows the collapsed row only.** The component is a
 * controlled disclosure (a `<button>` toggling `useState`) whose body is
 * `lazy` + `Suspense`. Clicking it open from a preview effect leaves the
 * capture inside the suspense fallback, so the card comes out blank — worse
 * than the honest collapsed state. The four permission flags change what the
 * expanded body lists, not this row, so a single cell is shown rather than
 * four identical ones.
 */

/** The disclosure as it sits in the Recovery Center, closed. */
export function Collapsed() {
  return (
    <RecoveryAutomationDisclosure
      canRecover
      canCancelCampaign
      canReadAutoHealing
      canDecideAutoHealing
    />
  )
}
