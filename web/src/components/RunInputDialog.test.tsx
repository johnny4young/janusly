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
    const field = screen.getByLabelText(/Invoice ID/i)
    expect(field).toHaveAttribute('aria-required', 'true')
    expect(screen.getByText('Required')).toBeInTheDocument()
  })

  it('blocks submit and surfaces a local error when a required field is empty', () => {
    const onSubmit = vi.fn()
    render(<RunInputDialog {...makeProps({ onSubmit })} />)
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/Invoice ID is required/i)).toBeInTheDocument()
  })

  it('clears a local field error as soon as the field changes', () => {
    render(<RunInputDialog {...makeProps()} />)
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(screen.getByText(/Invoice ID is required/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/Invoice ID/i), { target: { value: 'INV-1' } })

    expect(screen.queryByText(/Invoice ID is required/i)).not.toBeInTheDocument()
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
    fireEvent.change(screen.getByLabelText(/Invoice ID/i), { target: { value: 'INV-1' } })
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '42' } })
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ invoiceId: 'INV-1', amount: 42 })
  })

  it('hydrates nested schema values without admitting undeclared fields', () => {
    const onSubmit = vi.fn()
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: {
        customer: {
          type: 'object',
          properties: { name: { type: 'string' }, active: { type: 'boolean' } },
          required: ['name'],
        },
      },
    }
    render(<RunInputDialog {...makeProps({
      inputs: schema,
      initialValue: { customer: { name: 'Ada', active: true, hidden: 'drop me' } },
      onSubmit,
    })} />)

    expect(screen.getByLabelText(/name/i)).toHaveValue('Ada')
    expect(screen.getByLabelText(/Active/i)).toHaveValue('true')
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledWith({ customer: { name: 'Ada', active: true } })
  })

  it('prefills recursive object defaults and submits the effective input', () => {
    const onSubmit = vi.fn()
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      default: { customer: { name: 'Ada' } },
      properties: {
        customer: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            active: { type: 'boolean', default: true },
          },
          required: ['name'],
        },
      },
      required: ['customer'],
    }
    render(<RunInputDialog {...makeProps({ inputs: schema, onSubmit })} />)

    expect(screen.getByLabelText(/name/i)).toHaveValue('Ada')
    expect(screen.getByLabelText(/Active/i)).toHaveValue('true')
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledWith({ customer: { name: 'Ada', active: true } })
  })

  it('maps a JSONPath server error to the matching field', () => {
    const props = makeProps({ serverErrors: ['$.invoiceId must be a UUID'] })
    render(<RunInputDialog {...props} />)
    expect(screen.getByText(/Invoice ID must be a UUID/i)).toBeInTheDocument()
  })

  it('calls onCancel from the close button and from the ESC key', () => {
    const onCancel = vi.fn()
    render(<RunInputDialog {...makeProps({ onCancel })} />)
    fireEvent.click(screen.getByRole('button', { name: /Close run input/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('renders boolean and enum selects and submits the right values', () => {
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
    fireEvent.change(screen.getByLabelText(/Published/i), { target: { value: 'true' } })
    fireEvent.change(screen.getByLabelText(/priority/i), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledWith({ published: true, priority: 'high' })
  })

  it('requires an explicit true or false choice for required booleans', () => {
    const onSubmit = vi.fn()
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: { notifyCustomer: { type: 'boolean' } },
      required: ['notifyCustomer'],
    }
    render(<RunInputDialog {...makeProps({ inputs: schema, onSubmit })} />)

    const choice = screen.getByRole('combobox', { name: 'Notify Customer' })
    expect(choice).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Notify Customer is required')).toBeInTheDocument()

    fireEvent.change(choice, { target: { value: 'false' } })
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledWith({ notifyCustomer: false })
  })

  it('keeps an untouched optional boolean absent from the submitted payload', () => {
    const onSubmit = vi.fn()
    const schema: WorkflowInputSchemaShape = {
      type: 'object',
      properties: { send_email: { type: 'boolean' } },
    }
    render(<RunInputDialog {...makeProps({ inputs: schema, onSubmit })} />)

    expect(screen.getByRole('combobox', { name: 'Send Email' })).toHaveValue('')
    expect(screen.getByText('Optional')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Run workflow/i }))
    expect(onSubmit).toHaveBeenCalledWith({})
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

describe('<RunInputDialog /> presets', () => {
  it('renders no preset strip when the seam is unset (human forms unchanged)', () => {
    render(<RunInputDialog {...makeProps()} />)
    expect(screen.queryByTestId('run-input-presets')).not.toBeInTheDocument()
  })

  it('loads a preset into the form fields', () => {
    render(<RunInputDialog {...makeProps({
      presets: [{ name: 'VIP refund', input: { invoiceId: 'INV-777' } }],
    })} />)
    fireEvent.change(screen.getByTestId('run-input-preset-select'), {
      target: { value: 'VIP refund' },
    })
    expect(screen.getByLabelText(/Invoice ID/i)).toHaveValue('INV-777')
  })

  it('saves only a VALID current value under the typed name', async () => {
    const onSavePreset = vi.fn().mockResolvedValue(undefined)
    render(<RunInputDialog {...makeProps({ presets: [], onSavePreset })} />)

    // Empty required field: the save must surface the error, not persist.
    fireEvent.change(screen.getByTestId('run-input-preset-name'), {
      target: { value: 'draft' },
    })
    fireEvent.click(screen.getByTestId('run-input-preset-save'))
    expect(onSavePreset).not.toHaveBeenCalled()
    expect(screen.getByText(/Invoice ID is required/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/Invoice ID/i), { target: { value: 'INV-9' } })
    fireEvent.click(screen.getByTestId('run-input-preset-save'))
    expect(onSavePreset).toHaveBeenCalledWith('draft', { invoiceId: 'INV-9' })
  })
})
