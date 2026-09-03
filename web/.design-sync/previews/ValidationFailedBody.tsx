import { ValidationFailedBody } from '@janusly/web'
import { deadLetter, patchSuggestion } from './_fixtures'

/**
 * What the recovery dialog shows when a suggested patch does not survive
 * validation. The patch is never applied in this state — the body exists to
 * hand the operator the original error and the rejected patch together, so the
 * next step is a manual edit rather than a retry of the same suggestion.
 *
 * `playbookRetired` marks the case where the suggestion came from a saved
 * playbook that no longer validates, which is a signal to retire the playbook
 * rather than to fix this one run.
 */

/** A model-authored patch that failed validation. */
export function PatchRejected() {
  return (
    <ValidationFailedBody
      dlq={deadLetter}
      suggestion={patchSuggestion}
      selectedIndex={0}
      runId="run_9f21c4"
      errorJson={deadLetter.errorJson}
      failureSignature="HTTP 503 from billing.acme.com"
    />
  )
}

/** The same failure, traced to a playbook that has gone stale. */
export function RetiredPlaybook() {
  return (
    <ValidationFailedBody
      dlq={deadLetter}
      suggestion={{ ...patchSuggestion, mode: 'playbook' as const }}
      selectedIndex={0}
      runId="run_9f21c4"
      errorJson={deadLetter.errorJson}
      failureSignature="HTTP 503 from billing.acme.com"
      playbookRetired
    />
  )
}
