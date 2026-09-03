import { PlaybookMatchCard } from '@janusly/web'

/**
 * A saved recovery playbook that matches the current failure signature.
 * `successfulUses` against `regressions` is the track record an operator
 * weighs before reusing it. `busy` names which action is in flight — `null`
 * is the idle state. Note the emitted `.d.ts` shows `busy: "use" | "retire"`:
 * the prop extractor drops the `| null` arm, so the real contract is wider
 * than the generated type says.
 */

const provenPlaybook = {
  id: 'pb_5xx_timeout',
  workflowId: 'wf_invoice_recon',
  signature: 'sig_5xx_upstream_timeout',
  version: 4,
  status: 'active' as const,
  title: 'Raise the timeout for upstream maintenance windows',
  instructionsMarkdown:
    'Raise the step timeout to 90s. The provider publishes a nightly window between 02:00 and 02:15 UTC; runs that fail inside it recover on the first retry once the timeout covers the window.',
  approachLabel: 'raise_timeout',
  successfulUses: 23,
  regressions: 1,
  lastValidatedAt: '2026-08-20T02:07:41.000Z',
  activatedAt: '2026-05-02T11:00:00.000Z',
  retiredAt: null,
  createdAt: '2026-05-01T09:12:00.000Z',
  updatedAt: '2026-08-20T02:07:41.000Z',
}

/** A proven playbook — many successful uses, one regression. */
export function ProvenPlaybook() {
  return (
    <PlaybookMatchCard
      playbook={provenPlaybook}
      busy={null}
      onUse={() => {}}
      onRetire={() => {}}
    />
  )
}

/** A draft that has never been validated. */
export function UnvalidatedDraft() {
  return (
    <PlaybookMatchCard
      playbook={{
        ...provenPlaybook,
        id: 'pb_draft_retry',
        version: 1,
        status: 'draft',
        title: 'Add a bounded retry to the ledger write',
        instructionsMarkdown: 'Retry the ledger write twice with a 2s backoff before dead-lettering.',
        approachLabel: 'add_retry',
        successfulUses: 0,
        regressions: 0,
        lastValidatedAt: null,
        activatedAt: null,
      }}
      busy={null}
      onUse={() => {}}
      onRetire={() => {}}
    />
  )
}

/** A shaky record — regressions rival the successes. */
export function MixedRecord() {
  return (
    <PlaybookMatchCard
      playbook={{
        ...provenPlaybook,
        id: 'pb_swap_secret',
        title: 'Swap the credential reference after a rotation',
        approachLabel: 'swap_secret_ref',
        successfulUses: 6,
        regressions: 5,
      }}
      busy={null}
      onUse={() => {}}
      onRetire={() => {}}
    />
  )
}

/** Retirement in flight. */
export function RetiringInFlight() {
  return (
    <PlaybookMatchCard
      playbook={{ ...provenPlaybook, status: 'retired', retiredAt: '2026-08-26T10:00:00.000Z' }}
      busy="retire"
      onUse={() => {}}
      onRetire={() => {}}
    />
  )
}
