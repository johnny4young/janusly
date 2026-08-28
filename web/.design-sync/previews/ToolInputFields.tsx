import { ToolInputFields } from '@janusly/web'

/**
 * Renders one input control per field a tool declares, so a step's input is
 * edited against the tool's real contract rather than as free-form JSON.
 * Field `kind` picks the control; `required` drives the validation affordance.
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
    { name: 'metadata', kind: 'json' as const, required: false },
  ],
}

/** Every field kind at once, filled in. */
export function AllFieldKinds() {
  return (
    <ToolInputFields
      scope="ledger_step"
      tool={ledgerTool}
      input={{
        accountId: 'acct_88213',
        amount: 1284.5,
        currency: 'USD',
        dryRun: true,
        metadata: { source: 'invoice_reconciliation', invoiceId: 'inv_10482' },
      }}
      onChange={() => {}}
    />
  )
}

/** Nothing supplied yet — required fields are still unfilled. */
export function Empty() {
  return <ToolInputFields scope="ledger_step" tool={ledgerTool} input={{}} onChange={() => {}} />
}

/** A small read-only tool, for contrast with the write-capable one above. */
export function SimpleTool() {
  return (
    <ToolInputFields
      scope="lookup_step"
      tool={{
        name: 'invoice.lookup',
        description: 'Fetch an invoice and its line items.',
        writeSide: false,
        inputFields: [
          { name: 'invoiceId', kind: 'string' as const, required: true },
          { name: 'includeLineItems', kind: 'boolean' as const, required: false },
        ],
      }}
      input={{ invoiceId: 'inv_10482', includeLineItems: true }}
      onChange={() => {}}
    />
  )
}
