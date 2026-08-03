import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'
import { AiConfigEditor } from './AiConfigEditor'

vi.mock('../api', () => ({ api: vi.fn() }))
const apiMock = vi.mocked(api)

beforeEach(() => {
  initI18n('en')
  apiMock.mockReset()
  apiMock.mockResolvedValue({ prompts: [] })
})

describe('<AiConfigEditor />', () => {
  it('keeps the inline prompt path simple and defaults to text output', () => {
    const onUpdate = vi.fn()
    render(
      <AiConfigEditor
        nodeId="summarize"
        config={{ prompt: 'Summarize the invoice' }}
        onUpdate={onUpdate}
      />,
    )

    expect(screen.getByLabelText('Prompt source')).toHaveValue('inline')
    expect(screen.getByLabelText('Prompt')).toHaveValue('Summarize the invoice')
    expect(screen.getByLabelText('Output')).toHaveValue('text')
    expect(screen.getByTestId('ai-output-helper')).toHaveTextContent('output.response')
    expect(apiMock).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Prompt'), {
      target: { value: 'Classify the invoice' },
    })
    expect(onUpdate).toHaveBeenLastCalledWith({ prompt: 'Classify the invoice' })
  })

  it('switches among text, JSON text, and validated structured data without stale keys', () => {
    const onUpdate = vi.fn()
    const { rerender } = render(
      <AiConfigEditor nodeId="classify" config={{ prompt: 'Classify' }} onUpdate={onUpdate} />,
    )

    fireEvent.change(screen.getByLabelText('Output'), { target: { value: 'json' } })
    expect(onUpdate).toHaveBeenLastCalledWith({
      prompt: 'Classify',
      responseFormat: 'json',
    })

    rerender(
      <AiConfigEditor
        nodeId="classify"
        config={{ prompt: 'Classify', responseFormat: 'json' }}
        onUpdate={onUpdate}
      />,
    )
    fireEvent.change(screen.getByLabelText('Output'), { target: { value: 'structured' } })
    expect(onUpdate).toHaveBeenLastCalledWith({
      prompt: 'Classify',
      outputSchema: {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
      },
    })

    rerender(
      <AiConfigEditor
        nodeId="classify"
        config={{
          prompt: 'Classify',
          outputSchema: {
            type: 'object',
            properties: { result: { type: 'string' } },
            required: ['result'],
          },
        }}
        onUpdate={onUpdate}
      />,
    )
    expect(screen.getByLabelText('Output contract (JSON Schema)')).toBeVisible()
    expect(screen.getByTestId('ai-output-helper')).toHaveTextContent('output.data')
    fireEvent.change(screen.getByLabelText('Output'), { target: { value: 'text' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ prompt: 'Classify' })
  })

  it('loads saved prompts and writes a prompt reference with optional version and variables', async () => {
    apiMock.mockResolvedValue({
      prompts: [
        { name: 'invoice_classifier', description: 'Classify invoice risk.' },
        { name: 'daily_summary', description: null },
      ],
    })
    const onUpdate = vi.fn()
    const { rerender } = render(
      <AiConfigEditor nodeId="classify" config={{ prompt: 'Inline draft' }} onUpdate={onUpdate} />,
    )

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'saved' } })
    expect(onUpdate).toHaveBeenLastCalledWith({})
    await waitFor(() => {
      expect(screen.getByLabelText('Saved prompt')).toHaveTextContent('invoice_classifier')
    })

    fireEvent.change(screen.getByLabelText('Saved prompt'), {
      target: { value: 'invoice_classifier' },
    })
    expect(onUpdate).toHaveBeenLastCalledWith({
      promptRef: { name: 'invoice_classifier' },
    })

    rerender(
      <AiConfigEditor
        nodeId="classify"
        config={{ promptRef: { name: 'invoice_classifier' } }}
        onUpdate={onUpdate}
      />,
    )
    expect(screen.getByText('Classify invoice risk.')).toBeVisible()
    fireEvent.click(screen.getByText('Advanced options'))
    const version = screen.getByLabelText('Prompt version')
    fireEvent.change(version, { target: { value: '2' } })
    fireEvent.blur(version)
    expect(onUpdate).toHaveBeenLastCalledWith({
      promptRef: { name: 'invoice_classifier', version: 2 },
    })

    const variables = screen.getByLabelText('Prompt variables (JSON)')
    fireEvent.change(variables, { target: { value: '{"customer":"Ada"}' } })
    fireEvent.blur(variables)
    expect(onUpdate).toHaveBeenLastCalledWith({
      promptRef: { name: 'invoice_classifier' },
      variables: { customer: 'Ada' },
    })
  })

  it('deduplicates and bounds untrusted prompt registry results', async () => {
    apiMock.mockResolvedValue({
      prompts: [
        { name: '  invoice_classifier  ', description: 'First copy' },
        { name: 'invoice_classifier', description: 'Duplicate copy' },
        ...Array.from({ length: 250 }, (_, index) => ({ name: `prompt_${index}` })),
      ],
    })
    render(<AiConfigEditor nodeId="classify" config={{}} onUpdate={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'saved' } })
    await waitFor(() => {
      expect(screen.getByLabelText('Saved prompt').querySelectorAll('option')).toHaveLength(201)
    })
    expect(screen.getAllByRole('option', { name: 'invoice_classifier' })).toHaveLength(1)
  })

  it('keeps inline authoring available when the prompt registry cannot load', async () => {
    apiMock.mockRejectedValue(new Error('offline'))
    render(
      <AiConfigEditor
        nodeId="summarize"
        config={{ promptRef: { name: 'current_prompt' } }}
        onUpdate={vi.fn()}
      />,
    )

    expect(await screen.findByTestId('ai-prompts-empty')).toHaveTextContent(
      'Saved prompts could not be loaded',
    )
    expect(screen.getByLabelText('Saved prompt')).toHaveValue('current_prompt')
    fireEvent.change(screen.getByLabelText('Prompt source'), { target: { value: 'inline' } })
    expect(screen.getByLabelText('Prompt')).toBeVisible()
  })

  it('keeps the model override progressive and removes it when cleared', () => {
    const onUpdate = vi.fn()
    render(
      <AiConfigEditor
        nodeId="summarize"
        config={{ prompt: 'Summarize', model: 'anthropic/claude-haiku-4-5-20251001' }}
        onUpdate={onUpdate}
      />,
    )

    expect(screen.getByTestId('ai-options')).toHaveAttribute('open')
    const model = screen.getByLabelText('Model override')
    expect(model).toHaveValue('anthropic/claude-haiku-4-5-20251001')
    fireEvent.change(model, { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ prompt: 'Summarize' })
  })
})
