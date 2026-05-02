import { describe, expect, it } from 'vitest'
import { validateInputs, WorkflowInputValidationError } from './inputs-validator'
import type { WorkflowInputSchemaShape } from '@janusly/shared'

describe('validateInputs — primitives', () => {
  it('accepts a matching primitive', () => {
    expect(validateInputs({ type: 'string' }, 'hello')).toEqual({ valid: true })
    expect(validateInputs({ type: 'number' }, 42)).toEqual({ valid: true })
    expect(validateInputs({ type: 'boolean' }, true)).toEqual({ valid: true })
  })

  it('rejects a primitive type mismatch with a clear path', () => {
    const result = validateInputs({ type: 'string' }, 42)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toEqual(['$ must be string, got number'])
  })

  it('rejects NaN / Infinity for type number (only finite numbers count)', () => {
    expect(validateInputs({ type: 'number' }, Number.NaN).valid).toBe(false)
    expect(validateInputs({ type: 'number' }, Number.POSITIVE_INFINITY).valid).toBe(false)
  })

  it('distinguishes null from object in error messages', () => {
    const result = validateInputs({ type: 'object' }, null)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors[0]).toContain('null')
  })
})

describe('validateInputs — object with required + properties', () => {
  const invoiceSchema: WorkflowInputSchemaShape = {
    type: 'object',
    properties: { invoiceId: { type: 'string' } },
    required: ['invoiceId'],
  }

  it('rejects an empty payload missing the required field with the AC error', () => {
    const result = validateInputs(invoiceSchema, {})
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toEqual(['$.invoiceId is required'])
  })

  it('accepts the payload when the required field is present and well-typed', () => {
    expect(validateInputs(invoiceSchema, { invoiceId: 'INV-1' })).toEqual({ valid: true })
  })

  it('rejects a wrong-typed required field at the field path', () => {
    const result = validateInputs(invoiceSchema, { invoiceId: 42 })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toEqual(['$.invoiceId must be string, got number'])
  })

  it('aggregates multiple errors in one pass', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    }
    const result = validateInputs(schema, { a: 1 })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toContain('$.b is required')
      expect(result.errors).toContain('$.a must be string, got number')
    }
  })
})

describe('validateInputs — nested objects + arrays', () => {
  it('descends into nested object properties', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: {
        user: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      required: ['user'],
    }
    const result = validateInputs(schema, { user: {} })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toEqual(['$.user.id is required'])
  })

  it('validates each array item against the items schema', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'array',
      items: { type: 'string' },
    }
    const result = validateInputs(schema, ['a', 1, 'c'])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.errors).toEqual(['$[1] must be string, got number'])
  })
})

describe('validateInputs — enum', () => {
  it('accepts a value in the closed set', () => {
    const schema: WorkflowInputSchemaShape = { type: 'string', enum: ['low', 'medium', 'high'] }
    expect(validateInputs(schema, 'medium').valid).toBe(true)
  })

  it('rejects a value outside the closed set', () => {
    const schema: WorkflowInputSchemaShape = { type: 'string', enum: ['low', 'high'] }
    const result = validateInputs(schema, 'medium')
    expect(result.valid).toBe(false)
  })
})

describe('WorkflowInputValidationError', () => {
  it('wraps the errors list and exposes it on the instance', () => {
    const err = new WorkflowInputValidationError(['$.x is required'])
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('WorkflowInputValidationError')
    expect(err.errors).toEqual(['$.x is required'])
  })
})
