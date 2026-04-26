import { afterEach, describe, expect, it, vi } from 'vitest'
import { getByPath, mapInput, renderTemplate } from './template'

describe('getByPath', () => {
  it('reads nested paths', () => {
    expect(getByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
  })

  it('returns undefined when the path does not exist', () => {
    expect(getByPath({ a: 1 }, 'a.b.c')).toBeUndefined()
  })

  it('handles null sources without throwing', () => {
    expect(getByPath(null, 'a.b')).toBeUndefined()
  })
})

describe('renderTemplate', () => {
  const scope = {
    context: { http: { output: { statusCode: 200 } } },
    inputs: { name: 'Ada' },
  }

  it('replaces simple placeholders with values from scope', () => {
    expect(renderTemplate('hello {{inputs.name}}', scope)).toBe('hello Ada')
  })

  it('serializes objects as JSON inside strings', () => {
    expect(renderTemplate('payload {{context.http.output}}', scope)).toBe('payload {"statusCode":200}')
  })

  it('recursively renders arrays and objects', () => {
    const result = renderTemplate({ items: ['{{inputs.name}}', { code: '{{context.http.output.statusCode}}' }] }, scope)
    expect(result).toEqual({ items: ['Ada', { code: '200' }] })
  })

  it('substitutes env and secret placeholders when available', () => {
    vi.stubEnv('FOO_VALUE', 'bar')
    vi.stubEnv('SECRET_TOKEN', 's3cret')
    expect(renderTemplate('{{env.foo_value}}-{{secret.secret_token}}', { context: {}, inputs: {} })).toBe('bar-s3cret')
    vi.unstubAllEnvs()
  })

  it('mapInput accepts empty or null mappings', () => {
    expect(mapInput(null, { context: {}, inputs: {} })).toEqual({})
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})
