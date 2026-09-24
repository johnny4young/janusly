import { expect, it } from 'vitest'
import {
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isNullableString,
  isOptionalNullableString,
  isOptionalString,
} from './guards'

it.each([0, -0, 1, Number.MAX_SAFE_INTEGER])('accepts exact wire count %s', value => {
  expect(isNonNegativeSafeInteger(value)).toBe(true)
})

it.each([undefined, null, true, false, '', '0', '1', [], {}, -1, .1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1].map(value => [value]))('rejects invalid wire count %s', value => {
  expect(isNonNegativeSafeInteger(value)).toBe(false)
})

it('does not invoke coercion hooks on a hostile wire value', () => {
  expect(isNonNegativeSafeInteger({ valueOf() { throw new Error('must not coerce') } })).toBe(false)
})

it('keeps string presence semantics distinct', () => {
  const values = ['a', ' ', '', null, undefined, 0]
  expect(values.map(isNonEmptyString)).toEqual([true, false, false, false, false, false])
  expect(values.map(isNullableString)).toEqual([true, true, true, true, false, false])
  expect(values.map(isOptionalString)).toEqual([true, true, true, false, true, false])
  expect(values.map(isOptionalNullableString)).toEqual([true, true, true, true, true, false])
})

it.each([[0, true], [-1.5, true], [NaN, false], [Infinity, false], ['1', false], [null, false]])('finite number %s -> %s', (value, expected) => {
  expect(isFiniteNumber(value)).toBe(expected)
})
