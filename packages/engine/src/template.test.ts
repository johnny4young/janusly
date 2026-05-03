import { afterEach, describe, expect, it, vi } from 'vitest'
import { getByPath, mapInput, redactError, redactValues, renderTemplate, renderTemplateWithRedactions } from './template'

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

describe('renderTemplateWithRedactions — env values are tracked alongside secrets', () => {
  it('captures env values that meet the length floor', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-fake-secret-123456')
    const { rendered, redactedValues } = renderTemplateWithRedactions(
      { token: '{{env.OPENAI_API_KEY}}' },
      { context: {}, inputs: {} },
    )
    expect(rendered).toEqual({ token: 'sk-fake-secret-123456' })
    expect(redactedValues).toContain('sk-fake-secret-123456')
    vi.unstubAllEnvs()
  })

  it('skips env values shorter than the 4-char floor (avoids over-redaction of toy values)', () => {
    vi.stubEnv('NODE_ENV', 'dev')
    const { rendered, redactedValues } = renderTemplateWithRedactions(
      { mode: '{{env.NODE_ENV}}' },
      { context: {}, inputs: {} },
    )
    expect(rendered).toEqual({ mode: 'dev' })
    expect(redactedValues).not.toContain('dev')
    vi.unstubAllEnvs()
  })

  it('does not add the empty string when the env var is unset', () => {
    vi.stubEnv('TOTALLY_UNSET_VAR', '')
    const { redactedValues } = renderTemplateWithRedactions(
      { token: '{{env.TOTALLY_UNSET_VAR}}' },
      { context: {}, inputs: {} },
    )
    expect(redactedValues).not.toContain('')
    vi.unstubAllEnvs()
  })

  it('redactValues scrubs env-derived values from a simulated executor output (end-to-end)', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-leaky-key-abcdef-987654321')
    const { redactedValues } = renderTemplateWithRedactions(
      { token: '{{env.OPENAI_API_KEY}}' },
      { context: {}, inputs: {} },
    )
    // Simulate an executor that echoes the rendered token back in its output
    // (transform/tool/AI nodes commonly do this), and verify the post-pass
    // scrubs the literal before it would reach run_nodes.state_json.
    const executorOutput = {
      message: 'used token sk-leaky-key-abcdef-987654321 to call upstream',
      nested: { copied: 'sk-leaky-key-abcdef-987654321' },
    }
    expect(redactValues(executorOutput, redactedValues)).toEqual({
      message: 'used token [redacted] to call upstream',
      nested: { copied: '[redacted]' },
    })
    vi.unstubAllEnvs()
  })

  it('captures env AND secret values in the same render pass', () => {
    vi.stubEnv('SOME_API_KEY', 'env-key-12345678')
    vi.stubEnv('SECRET_TOKEN', 'secret-value-87654321')
    const { redactedValues } = renderTemplateWithRedactions(
      'env={{env.SOME_API_KEY}} secret={{secret.SECRET_TOKEN}}',
      { context: {}, inputs: {} },
    )
    expect(redactedValues).toEqual(expect.arrayContaining(['env-key-12345678', 'secret-value-87654321']))
    vi.unstubAllEnvs()
  })

  it('redactError scrubs error messages, stacks, codes, and causes before DLQ serialization', () => {
    const error = new Error('upstream rejected sk-error-key-123456')
    error.stack = 'Error: upstream rejected sk-error-key-123456\n    at run'
    const errorWithFields = error as Error & { code?: string; cause?: unknown }
    errorWithFields.code = 'TOKEN_sk-error-key-123456'
    errorWithFields.cause = {
      details: 'nested sk-error-key-123456',
    }

    const redacted = redactError(error, ['sk-error-key-123456']) as Error & { code?: string; cause?: unknown }

    expect(redacted.message).toBe('upstream rejected [redacted]')
    expect(redacted.stack).not.toContain('sk-error-key-123456')
    expect(redacted.code).toBe('TOKEN_[redacted]')
    expect(redacted.cause).toEqual({ details: 'nested [redacted]' })
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})
