import { TextConfigField } from '@janusly/web'

/**
 * Labelled single-line field for the quick-config editors. `scope` only
 * prefixes the generated id, so a label can repeat across editors without
 * colliding. The parent owns the value.
 */

/** A filled field, as the HTTP editor renders it. */
export function Filled() {
  return (
    <TextConfigField
      scope="http"
      label="Request URL"
      value="https://api.acme.com/v1/invoices"
      onChange={() => {}}
    />
  )
}

/** Empty, waiting for input. */
export function Empty() {
  return <TextConfigField scope="http" label="Bearer token reference" value="" onChange={() => {}} />
}

/** Several fields stacked, which is how the editors actually use them. */
export function Stacked() {
  return (
    <div>
      <TextConfigField scope="tool" label="Tool name" value="invoice_lookup" onChange={() => {}} />
      <TextConfigField scope="tool" label="Timeout" value="30s" onChange={() => {}} />
      <TextConfigField scope="tool" label="Retry policy" value="exponential" onChange={() => {}} />
    </div>
  )
}
