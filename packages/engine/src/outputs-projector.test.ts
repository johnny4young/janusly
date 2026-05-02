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
    expect(result).toEqual({ result: 'ok', count: '42' })
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

  it('serialises object lookups to JSON via the renderer', () => {
    const result = projectOutputs(
      { payload: '{{context.fetch.output}}' },
      { fetch: { output: { text: 'hi', count: 1 } } },
    )
    expect(result).toEqual({ payload: '{"text":"hi","count":1}' })
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
