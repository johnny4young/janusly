import { expect, it } from 'vitest'
import { isNonNegativeSafeInteger } from './guards'

it.each([0, -0, 1, Number.MAX_SAFE_INTEGER])('accepts exact wire count %s', value => {
  expect(isNonNegativeSafeInteger(value)).toBe(true)
})

it.each([undefined, null, true, false, '', '0', '1', [], {}, -1, .1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1].map(value => [value]))('rejects invalid wire count %s', value => {
  expect(isNonNegativeSafeInteger(value)).toBe(false)
})

it('does not invoke coercion hooks on a hostile wire value', () => {
  expect(isNonNegativeSafeInteger({ valueOf() { throw new Error('must not coerce') } })).toBe(false)
})
