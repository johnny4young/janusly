import { ReviewBody } from '@janusly/web'
import { deadLetter, patchSuggestion } from './_fixtures'

/**
 * The review step of the recovery dialog: the proposed patches, side by side,
 * with the evidence behind them.
 *
 * Two numbers matter and they are not the same. `confidence` is the model's raw
 * self-rating; `calibratedConfidence` is that score mapped through the
 * workspace's own history for that approach, and it is the one an operator
 * should act on — here the retry patch's calibrated score sits well below its
 * raw one because this workspace has seen retries over-promise.
 *
 * `canApplyPatch` gates the apply action; `selectionLocked` freezes the choice
 * once a patch is being applied.
 */

/** An operator choosing between two patches. */
export function ChoosingAPatch() {
  return (
    <ReviewBody
      dlq={deadLetter}
      suggestion={patchSuggestion}
      selected={patchSuggestion.suggestions[0]}
      selectedIndex={0}
      onSelectIndex={() => {}}
      canApplyPatch
      failureSignature="HTTP 503 from billing.acme.com"
    />
  )
}

/** A viewer without the recovery permission sees the same evidence, read-only. */
export function WithoutApplyPermission() {
  return (
    <ReviewBody
      dlq={deadLetter}
      suggestion={patchSuggestion}
      selected={patchSuggestion.suggestions[1]}
      selectedIndex={1}
      onSelectIndex={() => {}}
      canApplyPatch={false}
      failureSignature="HTTP 503 from billing.acme.com"
    />
  )
}
