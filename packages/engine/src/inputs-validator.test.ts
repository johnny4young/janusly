import { describe, expect, it } from 'vitest'
import { applyInputDefaults, validateInputs, WorkflowInputValidationError } from './inputs-validator'
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

describe('applyInputDefaults', () => {
  // The setting a trigger-driven workflow needs: declared once, same on every
  // run, read by nodes through `{{context.input.<name>}}`.
  const settings: WorkflowInputSchemaShape = {
    type: 'object',
    properties: {
      workingHoursStart: { type: 'string', default: '09:00' },
      workingHoursEnd: { type: 'string', default: '17:00' },
      timeZone: { type: 'string', default: 'UTC' },
      snoozeHours: { type: 'number', default: 12 },
    },
    required: ['workingHoursStart', 'workingHoursEnd', 'timeZone'],
  }

  it('fills declared defaults into an empty payload', () => {
    expect(applyInputDefaults(settings, {})).toEqual({
      workingHoursStart: '09:00',
      workingHoursEnd: '17:00',
      timeZone: 'UTC',
      snoozeHours: 12,
    })
  })

  it('lets a supplied value win over its default', () => {
    expect(applyInputDefaults(settings, { timeZone: 'America/Bogota' })).toMatchObject({
      timeZone: 'America/Bogota',
      workingHoursStart: '09:00',
    })
  })

  it('treats explicit null and false as supplied, not absent', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: true },
        note: { type: 'string', default: 'fallback' },
      },
    }
    expect(applyInputDefaults(schema, { enabled: false, note: null })).toEqual({
      enabled: false,
      note: null,
    })
  })

  it('never mutates the caller payload', () => {
    const supplied = { timeZone: 'Asia/Tokyo' }
    applyInputDefaults(settings, supplied)
    expect(supplied).toEqual({ timeZone: 'Asia/Tokyo' })
  })

  it('lets a trigger payload satisfy required settings that have defaults', () => {
    // The regression this exists for: a webhook/schedule run supplies the
    // event, never the declared fields, so without defaults every such run
    // was rejected at startRun.
    const triggerPayload = { triggeredBy: 'pagerduty_incident', event: { incidentId: 'P1' } }
    const resolved = applyInputDefaults(settings, triggerPayload)

    expect(validateInputs(settings, resolved)).toEqual({ valid: true })
    expect(resolved).toMatchObject({ triggeredBy: 'pagerduty_incident', workingHoursStart: '09:00' })
    // Without defaults the same payload is still rejected.
    expect(validateInputs(settings, triggerPayload).valid).toBe(false)
  })

  it('recurses into nested objects', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: {
        window: {
          type: 'object',
          properties: { start: { type: 'string', default: '09:00' }, end: { type: 'string', default: '17:00' } },
        },
      },
    }
    expect(applyInputDefaults(schema, { window: { start: '08:00' } }))
      .toEqual({ window: { start: '08:00', end: '17:00' } })
    // Absent nested object still materializes from its children's defaults.
    expect(applyInputDefaults(schema, {})).toEqual({ window: { start: '09:00', end: '17:00' } })
  })

  it('leaves an absent optional object absent when nothing defaults it', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: { extras: { type: 'object', properties: { note: { type: 'string' } } } },
    }
    expect(applyInputDefaults(schema, {})).toEqual({})
  })

  it('passes a wrong-typed default through for the validator to report', () => {
    // Terminates instead of recursing, and the type error still surfaces.
    const schema: WorkflowInputSchemaShape = { type: 'object', default: 'not-an-object' }
    expect(applyInputDefaults(schema, undefined)).toBe('not-an-object')
    expect(validateInputs(schema, applyInputDefaults(schema, undefined)).valid).toBe(false)
  })

  it('treats prototype-shaped field names as own JSON data', () => {
    const properties = Object.fromEntries([
      ['__proto__', { type: 'string', default: 'safe' }],
    ]) as Record<string, WorkflowInputSchemaShape>
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties,
      required: ['__proto__'],
    }

    const resolved = applyInputDefaults(schema, {}) as Record<string, unknown>

    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype)
    expect(Object.hasOwn(resolved, '__proto__')).toBe(true)
    expect(resolved.__proto__).toBe('safe')
    expect(validateInputs(schema, resolved)).toEqual({ valid: true })
  })
})
