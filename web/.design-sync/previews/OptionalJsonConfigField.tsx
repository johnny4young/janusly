import { OptionalJsonConfigField } from '@janusly/web'

/**
 * JSON field that can be left unset. Clearing it yields `undefined`, which
 * keeps "no value" distinct from "an empty object" — the engine treats those
 * differently when merging step defaults.
 */

/** Carrying an override. */
export function WithValue() {
  return (
    <OptionalJsonConfigField
      scope="tool"
      label="Input overrides"
      value={{ currency: 'USD', includeLineItems: true }}
      onChange={() => {}}
    />
  )
}

/** Unset — the placeholder says what happens without it. */
export function Unset() {
  return (
    <OptionalJsonConfigField
      scope="tool"
      label="Input overrides"
      value={undefined}
      placeholder="No overrides — the tool's declared defaults apply"
      onChange={() => {}}
    />
  )
}

/** Explicitly an empty object, which is NOT the same as unset. */
export function EmptyObject() {
  return (
    <OptionalJsonConfigField
      scope="tool"
      label="Input overrides"
      value={{}}
      onChange={() => {}}
    />
  )
}
