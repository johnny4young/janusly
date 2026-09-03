import { RecoveryPassportCard } from '@janusly/web'
import { deadLetter, patchSuggestion } from './_fixtures'

/**
 * The safety summary an operator reads before applying a recovery patch: what
 * the patch touches, whether it crosses to the write side, whether an approval
 * gate is present, and how far the sandbox got.
 *
 * `sandboxStatus` is a plain string (`not_run`, `running`, `passed`, `failed`)
 * and the card builds an i18n key from it — passing an object renders the raw
 * key instead of a label.
 *
 * `actionable` is the apply gate. It is deliberately separate from the sandbox
 * result: a workspace can allow applying a patch the sandbox never ran, and the
 * card has to make that combination legible rather than hiding it.
 */

const shared = {
  dlq: deadLetter,
  suggestion: patchSuggestion,
  selected: patchSuggestion.suggestions[0],
  failureSignature: 'HTTP 503 from billing.acme.com',
}

/** Sandbox passed and the operator may apply. */
export function SafeToApply() {
  return <RecoveryPassportCard {...shared} sandboxStatus="passed" actionable />
}

/** The sandbox rejected the patch — applying is off the table. */
export function SandboxFailed() {
  return <RecoveryPassportCard {...shared} sandboxStatus="failed" actionable={false} />
}

/** No sandbox run yet: the evidence is thinner, and the card does not pretend otherwise. */
export function NotRun() {
  return <RecoveryPassportCard {...shared} sandboxStatus="not_run" actionable={false} />
}
