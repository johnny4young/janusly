import { ToolPicker } from '@janusly/web'

/**
 * Chooses which tool a step calls. `writeSide: true` marks tools whose valid
 * invocations can mutate external state — that flag is what the consent and
 * validation-mode gates key off, so it is worth seeing in the list.
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
    name: 'slack.post',
    description: 'Post a message to a Slack channel.',
    writeSide: true,
    inputFields: [
      { name: 'channel', kind: 'string' as const, required: true },
      { name: 'text', kind: 'string' as const, required: true },
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

/** A read-only tool selected. */
export function ReadOnlyToolSelected() {
  return (
    <ToolPicker
      nodeId="lookup_step"
      selectedTool="invoice.lookup"
      tools={tools}
      onChange={() => {}}
    />
  )
}

/** A write-capable tool selected — the gated case. */
export function WriteToolSelected() {
  return (
    <ToolPicker nodeId="notify_step" selectedTool="slack.post" tools={tools} onChange={() => {}} />
  )
}

/** Nothing chosen yet. */
export function NoSelection() {
  return <ToolPicker nodeId="tool_1" selectedTool="" tools={tools} onChange={() => {}} />
}

/** No tools connected to the workspace at all. */
export function NoToolsAvailable() {
  return <ToolPicker nodeId="tool_1" selectedTool="" tools={[]} onChange={() => {}} />
}
