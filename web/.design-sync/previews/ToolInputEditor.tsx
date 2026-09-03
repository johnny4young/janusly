import { ToolInputEditor } from '@janusly/web'

/**
 * Edits a step's tool input. With a `tool` it renders that tool's declared
 * fields; without one it falls back to the raw editor labelled by `rawLabel`
 * — which is what a step pointed at an unknown or not-yet-loaded tool gets.
 */

const ledgerTool = {
  name: 'ledger.adjust',
  description: 'Write a correcting entry against a ledger account.',
  writeSide: true,
  inputFields: [
    { name: 'accountId', kind: 'string' as const, required: true },
    { name: 'amount', kind: 'number' as const, required: true },
    { name: 'reason', kind: 'string' as const, required: true },
  ],
}

/** Schema-driven, with the tool's declared fields. */
export function WithToolSchema() {
  return (
    <ToolInputEditor
      scope="ledger_step"
      tool={ledgerTool}
      rawLabel="Raw input"
      input={{ accountId: 'acct_88213', amount: 1284.5, reason: 'Line 7 double-counted upstream' }}
      onChange={() => {}}
    />
  )
}

/** No schema available — the raw fallback. */
export function RawFallback() {
  return (
    <ToolInputEditor
      scope="unknown_step"
      rawLabel="Raw input"
      input={{ accountId: 'acct_88213', amount: 1284.5 }}
      onChange={() => {}}
    />
  )
}

/** Nothing supplied yet. */
export function Empty() {
  return (
    <ToolInputEditor
      scope="ledger_step"
      tool={ledgerTool}
      rawLabel="Raw input"
      input={{}}
      onChange={() => {}}
    />
  )
}
