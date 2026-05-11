import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowInputSchemaShape } from '../types'
import { RunInputDialog } from './RunInputDialog'

function makeProps(
  overrides: Partial<React.ComponentProps<typeof RunInputDialog>> = {},
): React.ComponentProps<typeof RunInputDialog> {
  return {
    inputs: { type: 'object', properties: { invoiceId: { type: 'string' } }, required: ['invoiceId'] },
    workflowName: 'Test workflow',
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
}

describe('<RunInputDialog />', () => {
  it('marks required fields with aria-required', () => {
    render(<RunInputDialog {...makeProps()} />)
    const field = screen.getByLabelText(/invoiceId/i)
    expect(field).toHaveAttribute('aria-required', 'true')
  })

  it('blocks submit and surfaces a local error when a required field is empty', () => {
    const onSubmit = vi.fn()
    render(<RunInputDialog {...makeProps({ onSubmit })} />)
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/invoiceId is required/i)).toBeInTheDocument()
  })

  it('clears a local field error as soon as the field changes', () => {
    render(<RunInputDialog {...makeProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(screen.getByText(/invoiceId is required/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/invoiceId/i), { target: { value: 'INV-1' } })

    expect(screen.queryByText(/invoiceId is required/i)).not.toBeInTheDocument()
  })

  it('submits with parsed values, coercing number fields', async () => {
    const onSubmit = vi.fn()
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: {
        invoiceId: { type: 'string' },
        amount: { type: 'number' },
      },
      required: ['invoiceId', 'amount'],
    }
    render(<RunInputDialog {...makeProps({ inputs: schema, onSubmit })} />)
    fireEvent.change(screen.getByLabelText(/invoiceId/i), { target: { value: 'INV-1' } })
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '42' } })
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ invoiceId: 'INV-1', amount: 42 })
  })

  it('maps a JSONPath server error to the matching field', () => {
    const props = makeProps({ serverErrors: ['$.invoiceId must be a UUID'] })
    render(<RunInputDialog {...props} />)
    expect(screen.getByText(/invoiceId must be a UUID/i)).toBeInTheDocument()
  })

  it('calls onCancel from the close button and from the ESC key', () => {
    const onCancel = vi.fn()
    render(<RunInputDialog {...makeProps({ onCancel })} />)
    fireEvent.click(screen.getByRole('button', { name: /Close run input/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('renders boolean checkbox + enum select and submits the right values', () => {
    const onSubmit = vi.fn()
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: {
        published: { type: 'boolean' },
        priority: { type: 'string', enum: ['low', 'high'] },
      },
      required: ['priority'],
    }
    render(<RunInputDialog {...makeProps({ inputs: schema, onSubmit })} />)
    fireEvent.click(screen.getByLabelText(/published/i))
    fireEvent.change(screen.getByLabelText(/priority/i), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledWith({ published: true, priority: 'high' })
  })

  it('parses an array root via JSON textarea and rejects malformed JSON', () => {
    const onSubmit = vi.fn()
    const schema: WorkflowInputSchemaShape = { type: 'array', items: { type: 'string' } }
    const { rerender } = render(<RunInputDialog {...makeProps({ inputs: schema, onSubmit })} />)
    const textarea = screen.getByRole('textbox', { name: 'Input' })
    fireEvent.change(textarea, { target: { value: '["a","b"]' } })
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledWith(['a', 'b'])

    rerender(<RunInputDialog {...makeProps({ inputs: schema, onSubmit })} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Input' }), { target: { value: 'not json' } })
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/must be valid JSON/i)).toBeInTheDocument()
  })

  it('supports custom schema-dialog copy for reused form surfaces', () => {
    render(<RunInputDialog {...makeProps({
      kicker: 'Form step',
      title: 'Complete review',
      description: 'Fill the requested fields.',
      submitLabel: 'Submit form',
      closeLabel: 'Close form',
    })} />)

    expect(screen.getByText('Form step')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Complete review' })).toBeInTheDocument()
    expect(screen.getByText('Fill the requested fields.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Submit form/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Close form/i })).toBeInTheDocument()
  })
})
