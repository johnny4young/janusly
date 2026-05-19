import { describe, expect, it } from 'vitest'
import { projectOutputs } from './outputs-projector'

describe('projectOutputs', () => {
  it('renders a single context-path template', () => {
    const result = projectOutputs(
      { result: '{{context.summarize.output.text}}' },
      { summarize: { output: { text: 'hello' } } },
    )
    expect(result).toEqual({ result: 'hello' })
  })

  it('preserves keys verbatim across multiple outputs', () => {
    const result = projectOutputs(
      {
        result: '{{context.fetch.output.text}}',
        count: '{{context.fetch.output.count}}',
      },
      { fetch: { output: { text: 'ok', count: 42 } } },
    )
    // Single-template-reference shape preserves the raw resolved value
    // (number stays a number) so JSON-typed outputs survive intact.
    expect(result).toEqual({ result: 'ok', count: 42 })
  })

  it('returns an empty record for an empty spec', () => {
    expect(projectOutputs({}, { x: { output: { y: 1 } } })).toEqual({})
  })

  it('resolves missing context paths to empty string (per renderTemplate contract)', () => {
    const result = projectOutputs(
      { result: '{{context.missing.output.text}}' },
      { other: { output: { text: 'ignored' } } },
    )
    expect(result).toEqual({ result: '' })
  })

  it('passes through inputs paths to the template renderer', () => {
    const result = projectOutputs(
      { echo: '{{inputs.invoiceId}}' },
      {},
      { invoiceId: 'INV-1' },
    )
    expect(result).toEqual({ echo: 'INV-1' })
  })

  it('can project a primitive root input with {{inputs}}', () => {
    expect(projectOutputs({ echo: '{{inputs}}' }, {}, 'INV-1')).toEqual({ echo: 'INV-1' })
  })

  it('preserves object lookups as raw values when the entire template is one reference', () => {
    const result = projectOutputs(
      { payload: '{{context.fetch.output}}' },
      { fetch: { output: { text: 'hi', count: 1 } } },
    )
    // Single-template-reference shape returns the raw object so the
    // declared output is a structured JSON document, not an opaque
    // stringified blob.
    expect(result).toEqual({ payload: { text: 'hi', count: 1 } })
  })

  it('still stringifies object lookups inside multi-reference / interpolated strings', () => {
    const result = projectOutputs(
      { sentence: 'payload was {{context.fetch.output}} (verbose)' },
      { fetch: { output: { text: 'hi', count: 1 } } },
    )
    expect(result).toEqual({ sentence: 'payload was {"text":"hi","count":1} (verbose)' })
  })

  it('redacts secret and env references before output persistence', () => {
    const previous = process.env.JANUSLY_OUTPUT_TEST_SECRET
    process.env.JANUSLY_OUTPUT_TEST_SECRET = 'must-not-leak'
    try {
      const result = projectOutputs(
        {
          secret: '{{secret.JANUSLY_OUTPUT_TEST_SECRET}}',
          env: 'value={{env.JANUSLY_OUTPUT_TEST_SECRET}}',
        },
        {},
      )

      expect(result).toEqual({ secret: '[redacted]', env: 'value=[redacted]' })
    } finally {
      if (previous === undefined) delete process.env.JANUSLY_OUTPUT_TEST_SECRET
      else process.env.JANUSLY_OUTPUT_TEST_SECRET = previous
    }
  })
})
