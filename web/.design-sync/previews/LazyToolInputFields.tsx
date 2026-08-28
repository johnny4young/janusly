import { LazyToolInputFields } from '@janusly/web'

/**
 * Deferred-loading wrapper around `ToolInputFields`, used where the tool
 * catalog is fetched on demand rather than held on the boot path. The rendered
 * result is the same field set — this variant just keeps the catalog off the
 * cold load.
 */

const ledgerTool = {
  name: 'ledger.adjust',
  description: 'Write a correcting entry against a ledger account.',
  writeSide: true,
  inputFields: [
    { name: 'accountId', kind: 'string' as const, required: true },
    { name: 'amount', kind: 'number' as const, required: true },
    { name: 'currency', kind: 'string' as const, required: true, options: ['USD', 'EUR', 'COP'] },
    { name: 'dryRun', kind: 'boolean' as const, required: false },
  ],
}

/** Fields resolved and filled. */
export function Filled() {
  return (
    <LazyToolInputFields
      scope="ledger_step"
      tool={ledgerTool}
      input={{ accountId: 'acct_88213', amount: 1284.5, currency: 'USD', dryRun: true }}
      onChange={() => {}}
    />
  )
}

/** Resolved but nothing entered yet. */
export function Empty() {
  return (
    <LazyToolInputFields scope="ledger_step" tool={ledgerTool} input={{}} onChange={() => {}} />
  )
}
