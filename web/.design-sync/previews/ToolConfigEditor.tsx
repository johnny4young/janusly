import { ToolConfigEditor } from '@janusly/web'

/**
 * Quick-config editor for a tool step: which tool the step calls, plus that
 * tool's input. Write-capable tools stay gated by capability metadata and
 * tenant consent regardless of what is configured here.
 */

const tools = [
  {
    name: 'invoice.lookup',
    description: 'Fetch an invoice and its line items from the billing system.',
    writeSide: false,
    inputFields: [
      { name: 'invoiceId', kind: 'string' as const, required: true },
      { name: 'includeLineItems', kind: 'boolean' as const, required: false },
    ],
  },
  {
    name: 'ledger.adjust',
    description: 'Write a correcting entry against a ledger account.',
    writeSide: true,
    inputFields: [
      { name: 'accountId', kind: 'string' as const, required: true },
      { name: 'amount', kind: 'number' as const, required: true },
      { name: 'reason', kind: 'string' as const, required: true },
    ],
  },
]

/** A read-only tool configured with its input. */
export function ReadOnlyTool() {
  return (
    <ToolConfigEditor
      nodeId="lookup_step"
      tools={tools}
      config={{ tool: 'invoice.lookup', input: { invoiceId: '{{ inputs.invoiceId }}', includeLineItems: true } }}
      onUpdate={() => {}}
    />
  )
}

/** A write-capable tool — the gated path. */
export function WriteCapableTool() {
  return (
    <ToolConfigEditor
      nodeId="adjust_step"
      tools={tools}
      config={{
        tool: 'ledger.adjust',
        input: { accountId: 'acct_88213', amount: 1284.5, reason: 'Reconciliation correction' },
      }}
      onUpdate={() => {}}
    />
  )
}

/** A fresh step with no tool chosen. */
export function Empty() {
  return <ToolConfigEditor nodeId="tool_1" tools={tools} config={{}} onUpdate={() => {}} />
}
