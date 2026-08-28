import { TextareaConfigField } from '@janusly/web'

/**
 * Multi-line sibling of `TextConfigField`, for prompts, bodies, and any
 * config value that runs past one line.
 */

/** Carrying a real prompt, as the agent editor renders it. */
export function Filled() {
  return (
    <TextareaConfigField
      scope="agent"
      label="System prompt"
      value={
        'You are a billing operations assistant. Given an invoice id, look up the invoice, ' +
        'check it against the purchase order, and report any discrepancy in line items or ' +
        'totals. Never modify the invoice — report only.'
      }
      onChange={() => {}}
    />
  )
}

/** Empty, waiting for input. */
export function Empty() {
  return (
    <TextareaConfigField scope="agent" label="Fallback message" value="" onChange={() => {}} />
  )
}
