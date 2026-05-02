import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decideForwardedInput, maxSubworkflowDepth, sanitizeForwardedInput } from './subworkflow'

describe('maxSubworkflowDepth', () => {
  const original = process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH

  beforeEach(() => { delete process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH })
  afterEach(() => {
    if (original === undefined) delete process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH
    else process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH = original
  })

  it('defaults to 5 when the env var is unset', () => {
    expect(maxSubworkflowDepth()).toBe(5)
  })

  it('honors a positive integer override', () => {
    process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH = '12'
    expect(maxSubworkflowDepth()).toBe(12)
  })

  it('floors fractional overrides', () => {
    process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH = '3.7'
    expect(maxSubworkflowDepth()).toBe(3)
  })

  it('falls back to 5 for non-finite or non-positive values', () => {
    process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH = 'abc'
    expect(maxSubworkflowDepth()).toBe(5)
    process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH = '0'
    expect(maxSubworkflowDepth()).toBe(5)
    process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH = '-3'
    expect(maxSubworkflowDepth()).toBe(5)
  })
})

describe('decideForwardedInput — precedence rule', () => {
  it('uses config.input when present, even if parent has its own input', () => {
    expect(decideForwardedInput({ msg: 'override' }, { msg: 'parent' })).toEqual({ msg: 'override' })
  })

  it('inherits parent input when config.input is undefined', () => {
    expect(decideForwardedInput(undefined, { msg: 'parent' })).toEqual({ msg: 'parent' })
  })

  it('falls back to {} when both are unset', () => {
    expect(decideForwardedInput(undefined, undefined)).toEqual({})
  })

  it('treats config.input: null as a valid override (resolves to {})', () => {
    // null is intentional — author wants to send no input even when parent has one.
    expect(decideForwardedInput(null, { msg: 'parent' })).toEqual({})
  })

  it('falls back to {} when parent input is null', () => {
    expect(decideForwardedInput(undefined, null)).toEqual({})
  })

  it('preserves config.input as-is when it is a non-trivial object', () => {
    const input = { invoiceId: 'INV-1', meta: { source: 'ui' } }
    expect(decideForwardedInput(input, undefined)).toEqual(input)
  })
})

describe('sanitizeForwardedInput', () => {
  it('redacts resolved secret values before child input persistence', () => {
    const input = { token: 'secret-value', nested: ['safe', 'secret-value'] }
    expect(sanitizeForwardedInput(input, ['secret-value'])).toEqual({
      token: '[redacted]',
      nested: ['safe', '[redacted]'],
    })
  })
})
