import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'
import { AiConfigEditor } from './AiConfigEditor'

vi.mock('../api', () => {
  const module = ({ api: vi.fn() })
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})
const apiMock = vi.mocked(api)

beforeEach(() => {
  initI18n('en')
  apiMock.mockResolvedValue({ prompts: [] })
})

describe('<AiConfigEditor /> browser smoke', () => {
  it('keeps primary AI controls aligned and exposes structured output progressively', () => {
    const onUpdate = vi.fn()
    const { rerender } = render(
      <div style={{ width: 420 }}>
        <AiConfigEditor
          nodeId="classify"
          config={{ prompt: 'Classify the invoice' }}
          onUpdate={onUpdate}
        />
      </div>,
    )

    const source = screen.getByLabelText('Prompt source')
    const prompt = screen.getByLabelText('Prompt')
    const output = screen.getByLabelText('Output')
    const bounds = [source, prompt, output].map((field) => field.getBoundingClientRect())
    // The semantic quick-setup card intentionally insets controls from its
    // 420px frame while keeping every primary field on the same grid line.
    expect(bounds.every(({ width, height }) => width >= 380 && height > 0)).toBe(true)
    expect(Math.max(...bounds.map(({ left }) => left)) - Math.min(...bounds.map(({ left }) => left)))
      .toBeLessThanOrEqual(1)
    expect(Math.max(...bounds.map(({ right }) => right)) - Math.min(...bounds.map(({ right }) => right)))
      .toBeLessThanOrEqual(1)

    fireEvent.change(output, { target: { value: 'structured' } })
    rerender(
      <div style={{ width: 420 }}>
        <AiConfigEditor
          nodeId="classify"
          config={{
            prompt: 'Classify the invoice',
            outputSchema: {
              type: 'object',
              properties: { result: { type: 'string' } },
              required: ['result'],
            },
          }}
          onUpdate={onUpdate}
        />
      </div>,
    )

    expect(screen.getByLabelText('Output contract (JSON Schema)')).toBeVisible()
    expect(screen.getByTestId('ai-output-helper')).toHaveTextContent('output.data')
    expect(screen.getByTestId('ai-options')).not.toHaveAttribute('open')
  })
})
