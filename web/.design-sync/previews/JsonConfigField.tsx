import { JsonConfigField } from '@janusly/web'

/**
 * Structured config value edited as JSON. The field owns parsing and surfaces
 * its own invalid-JSON state; the parent only receives well-formed values.
 */

/** An HTTP header map — the most common shape. */
export function Headers() {
  return (
    <JsonConfigField
      scope="http"
      label="Headers"
      value={{ 'content-type': 'application/json', 'x-acme-tenant': 'acme-prod' }}
      onChange={() => {}}
    />
  )
}

/** A nested object, to show how the field handles depth. */
export function NestedObject() {
  return (
    <JsonConfigField
      scope="tool"
      label="Default input"
      value={{
        invoice: { id: 'inv_10482', currency: 'USD' },
        options: { includeLineItems: true, maxLines: 50 },
      }}
      onChange={() => {}}
    />
  )
}

/** Empty object — the starting state. */
export function EmptyObject() {
  return <JsonConfigField scope="http" label="Query parameters" value={{}} onChange={() => {}} />
}
