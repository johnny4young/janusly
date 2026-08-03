import { describe, expect, it } from 'vitest'
import type { WorkflowInputSchemaShape } from '../types'
import {
  inputDisplayLabel,
  orderedRunInputEntries,
  parseRunInputState,
  splitRunInputServerErrors,
} from './run-input-model'

describe('run input model', () => {
  it.each([
    ['invoiceId', 'Invoice ID'],
    ['callback_url', 'Callback URL'],
    ['HTTPResponseCode', 'HTTP Response Code'],
    ['customer.api_key', 'API Key'],
  ])('turns the durable key %s into the readable label %s', (key, label) => {
    expect(inputDisplayLabel(key)).toBe(label)
  })

  it('requires an empty primitive root when the schema has no default', () => {
    const result = parseRunInputState({ __root__: '' }, { type: 'string' })

    expect(result.value).toBeUndefined()
    expect(result.errors).toEqual({ '': 'Input is required' })
  })

  it('orders required fields first and stabilizes each group by readable label', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: {
        tags: { type: 'array' },
        notifyCustomer: { type: 'boolean' },
        invoiceId: { type: 'string' },
        retry_count: { type: 'number' },
      },
      required: ['notifyCustomer', 'invoiceId'],
    }

    expect(orderedRunInputEntries(schema).map(([key]) => key)).toEqual([
      'invoiceId',
      'notifyCustomer',
      'retry_count',
      'tags',
    ])
  })

  it('lets the engine reapply a primitive root default after the field is cleared', () => {
    const result = parseRunInputState({ __root__: '' }, { type: 'string', default: 'daily' })

    expect(result).toEqual({ value: undefined, errors: {} })
  })

  it('preserves explicit false and omits an untouched optional boolean', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: {
        notifyCustomer: { type: 'boolean' },
        archive_result: { type: 'boolean' },
      },
      required: ['notifyCustomer'],
    }

    expect(parseRunInputState(
      { notifyCustomer: false, archive_result: '' },
      schema,
    )).toEqual({
      value: { notifyCustomer: false },
      errors: {},
    })
  })

  it('requires an explicit choice for a required boolean', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: { notifyCustomer: { type: 'boolean' } },
      required: ['notifyCustomer'],
    }

    expect(parseRunInputState({ notifyCustomer: '' }, schema)).toEqual({
      value: {},
      errors: { notifyCustomer: 'Notify Customer is required' },
    })
  })

  it('maps server JSONPath errors to readable labels without changing their keys', () => {
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: { invoiceId: { type: 'string' } },
    }

    expect(splitRunInputServerErrors(['$.invoiceId must be a UUID'], schema)).toEqual({
      mappedServerErrors: { invoiceId: 'Invoice ID must be a UUID' },
      formLevelServerErrors: [],
    })
  })
})
