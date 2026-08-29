import { CancellingBody } from '@janusly/web'
import { deadLetter, patchSuggestion } from './_fixtures'

/**
 * The decline step. When an operator rejects a suggested patch, Janusly asks
 * why before closing — the comment is what the recovery loop learns from, so
 * this is a feedback capture, not a confirmation dialog.
 *
 * `selectedIndex` records which of the suggestions was declined, so the
 * feedback attaches to an approach rather than to the incident as a whole.
 */
export function DecliningAPatch() {
  return (
    <CancellingBody
      dlq={deadLetter}
      suggestion={patchSuggestion}
      selectedIndex={0}
      onSubmit={() => {}}
      onBack={() => {}}
    />
  )
}
