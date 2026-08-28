import { OptionalNumberConfigField } from '@janusly/web'

/**
 * Numeric field that can be left unset. Clearing it calls `onChange` with
 * `undefined` rather than `0`, so "no override" stays distinguishable from
 * "explicitly zero" — which matters for every field where the engine has its
 * own default.
 */

/** Overridden with an explicit value. */
export function WithValue() {
  return (
    <OptionalNumberConfigField
      scope="resilience"
      label="Max attempts"
      value={5}
      min={1}
      max={10}
      onChange={() => {}}
    />
  )
}

/** Unset — the placeholder names the default that applies instead. */
export function Unset() {
  return (
    <OptionalNumberConfigField
      scope="resilience"
      label="Backoff (ms)"
      value={undefined as unknown as number}
      placeholder="Engine default (1000)"
      onChange={() => {}}
    />
  )
}

/** A bounded field with a step, as the rollout editor uses it. */
export function WithBounds() {
  return (
    <OptionalNumberConfigField
      scope="rollout"
      label="Canary traffic (%)"
      value={25}
      min={0}
      max={100}
      step={5}
      onChange={() => {}}
    />
  )
}
