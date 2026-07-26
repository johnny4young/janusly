import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowDefinition } from '../types'
import { WorkflowIoEditor } from './WorkflowIoEditor'

function Harness({ initialInputs, initialOutputs, initialTemplatePolicy }: {
  initialInputs?: WorkflowDefinition['inputs']
  initialOutputs?: WorkflowDefinition['outputs']
  initialTemplatePolicy?: WorkflowDefinition['templatePolicy']
}) {
  const [inputs, setInputs] = useState(initialInputs)
  const [outputs, setOutputs] = useState(initialOutputs)
  const [templatePolicy, setTemplatePolicy] = useState(initialTemplatePolicy)
  return (
    <>
      <WorkflowIoEditor
        workflowId="workflow-a"
        inputs={inputs}
        outputs={outputs}
        templatePolicy={templatePolicy}
        onChangeInputs={setInputs}
        onChangeOutputs={setOutputs}
        onChangeTemplatePolicy={setTemplatePolicy}
      />
      <output data-testid="io-state">{JSON.stringify({ inputs, outputs, templatePolicy })}</output>
    </>
  )
}

describe('<WorkflowIoEditor />', () => {
  it('authors a typed required input and a named output template', () => {
    render(<Harness />)

    fireEvent.click(screen.getByTestId('workflow-input-add'))
    const inputName = screen.getByLabelText('Input name: input')
    fireEvent.change(inputName, { target: { value: 'invoiceId' } })
    fireEvent.blur(inputName)

    fireEvent.change(screen.getByLabelText('Type for input invoiceId'), { target: { value: 'number' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Required input: invoiceId' }))
    fireEvent.change(screen.getByLabelText('Description for input invoiceId'), { target: { value: 'Invoice identifier' } })

    fireEvent.click(screen.getByTestId('workflow-output-add'))
    const outputName = screen.getByLabelText('Output name: result')
    fireEvent.change(outputName, { target: { value: 'approvedInvoice' } })
    fireEvent.blur(outputName)
    fireEvent.change(screen.getByLabelText('Template for output approvedInvoice'), {
      target: { value: '{{context.review.output}}' },
    })

    expect(JSON.parse(screen.getByTestId('io-state').textContent ?? '{}')).toEqual({
      inputs: {
        type: 'object',
        properties: { invoiceId: { type: 'number', description: 'Invoice identifier' } },
        required: ['invoiceId'],
      },
      outputs: { approvedInvoice: '{{context.review.output}}' },
    })
  })

  it('authors strict template handling and can return to the compatible default', () => {
    render(<Harness />)

    const strict = screen.getByRole('checkbox', { name: 'Fail on a missing value' })
    const policy = screen.getByTestId('workflow-template-policy')
    expect(strict).not.toBeChecked()
    expect(policy.getElementsByTagName('p')[1]).toHaveTextContent('Continue with an empty value')

    fireEvent.click(strict)
    expect(JSON.parse(screen.getByTestId('io-state').textContent ?? '{}')).toEqual({ templatePolicy: 'strict' })
    expect(policy.getElementsByTagName('p')[1]).toHaveTextContent('Stop before using a missing value')

    fireEvent.click(strict)
    expect(JSON.parse(screen.getByTestId('io-state').textContent ?? '{}')).toEqual({})
  })

  it('rejects duplicate input and output names without mutating the contract', () => {
    render(<Harness
      initialInputs={{
        type: 'object',
        properties: { first: { type: 'string' }, second: { type: 'boolean' } },
      }}
      initialOutputs={{ primary: 'a', secondary: 'b' }}
    />)

    const inputName = screen.getByLabelText('Input name: first')
    fireEvent.change(inputName, { target: { value: 'second' } })
    fireEvent.blur(inputName)
    expect(screen.getByRole('alert')).toHaveTextContent('Use a unique, non-empty name.')
    expect(inputName).toHaveAttribute('aria-invalid', 'true')
    expect(inputName).toHaveAccessibleDescription('Use a unique, non-empty name.')

    const outputName = screen.getByLabelText('Output name: primary')
    fireEvent.change(outputName, { target: { value: 'secondary' } })
    fireEvent.blur(outputName)
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(outputName).toHaveAttribute('aria-invalid', 'true')
    expect(outputName).toHaveAccessibleDescription('Use a unique, non-empty name.')

    expect(JSON.parse(screen.getByTestId('io-state').textContent ?? '{}')).toEqual({
      inputs: {
        type: 'object',
        properties: { first: { type: 'string' }, second: { type: 'boolean' } },
      },
      outputs: { primary: 'a', secondary: 'b' },
    })
  })

  it('preserves a non-object root schema instead of offering a destructive editor', () => {
    render(<Harness initialInputs={{ type: 'array', items: { type: 'string' } }} />)

    expect(screen.getByText(/array root contract is preserved as-is/)).toBeInTheDocument()
    expect(screen.queryByTestId('workflow-input-add')).toBeNull()
    expect(JSON.parse(screen.getByTestId('io-state').textContent ?? '{}').inputs).toEqual({
      type: 'array',
      items: { type: 'string' },
    })
  })

  it('removes empty input and output contracts after their final row is deleted', () => {
    render(<Harness
      initialInputs={{ type: 'object', properties: { invoiceId: { type: 'string' } } }}
      initialOutputs={{ result: 'value' }}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Remove input invoiceId' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove output result' }))

    expect(JSON.parse(screen.getByTestId('io-state').textContent ?? '{}')).toEqual({})
    expect(screen.getByText('No declared inputs yet.')).toBeInTheDocument()
    expect(screen.getByText('No projected outputs yet.')).toBeInTheDocument()
  })

  it('allows field names that match inherited object properties', () => {
    render(<Harness initialInputs={{ type: 'object', properties: { input: { type: 'string' } } }} />)

    const inputName = screen.getByLabelText('Input name: input')
    fireEvent.change(inputName, { target: { value: 'toString' } })
    fireEvent.blur(inputName)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(JSON.parse(screen.getByTestId('io-state').textContent ?? '{}').inputs.properties).toEqual({
      toString: { type: 'string' },
    })
  })

  it('normalizes surrounding whitespace after same-name input and output commits', () => {
    render(<Harness
      initialInputs={{ type: 'object', properties: { invoiceId: { type: 'string' } } }}
      initialOutputs={{ result: 'value' }}
    />)

    const inputName = screen.getByLabelText('Input name: invoiceId')
    fireEvent.change(inputName, { target: { value: '  invoiceId  ' } })
    fireEvent.blur(inputName)
    expect(inputName).toHaveValue('invoiceId')

    const outputName = screen.getByLabelText('Output name: result')
    fireEvent.change(outputName, { target: { value: '  result  ' } })
    fireEvent.blur(outputName)
    expect(outputName).toHaveValue('result')
    expect(JSON.parse(screen.getByTestId('io-state').textContent ?? '{}')).toEqual({
      inputs: { type: 'object', properties: { invoiceId: { type: 'string' } } },
      outputs: { result: 'value' },
    })
  })

  it('resets row-local rename drafts when the workflow identity changes', () => {
    const inputs: WorkflowDefinition['inputs'] = {
      type: 'object',
      properties: { first: { type: 'string' }, second: { type: 'boolean' } },
    }
    const onChangeInputs = vi.fn()
    const onChangeOutputs = vi.fn()
    const onChangeTemplatePolicy = vi.fn()
    const { rerender } = render(
      <WorkflowIoEditor
        workflowId="workflow-a"
        inputs={inputs}
        onChangeInputs={onChangeInputs}
        onChangeOutputs={onChangeOutputs}
        onChangeTemplatePolicy={onChangeTemplatePolicy}
      />,
    )
    const firstName = screen.getByLabelText('Input name: first')
    fireEvent.change(firstName, { target: { value: 'second' } })
    fireEvent.blur(firstName)
    expect(firstName).toHaveValue('second')
    expect(screen.getByRole('alert')).toBeInTheDocument()

    rerender(
      <WorkflowIoEditor
        workflowId="workflow-b"
        inputs={inputs}
        onChangeInputs={onChangeInputs}
        onChangeOutputs={onChangeOutputs}
        onChangeTemplatePolicy={onChangeTemplatePolicy}
      />,
    )

    expect(screen.getByLabelText('Input name: first')).toHaveValue('first')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('<WorkflowIoEditor /> — declared defaults', () => {
  const state = () => JSON.parse(screen.getByTestId('io-state').textContent ?? '{}')

  it('edits a string default without touching JSON', () => {
    render(<Harness initialInputs={{
      type: 'object',
      properties: { timeZone: { type: 'string' } },
      required: ['timeZone'],
    }} />)

    fireEvent.change(screen.getByLabelText('Default value for timeZone'), {
      target: { value: 'Europe/Madrid' },
    })

    expect(state().inputs.properties.timeZone).toEqual({ type: 'string', default: 'Europe/Madrid' })
  })

  it('stores a number default as a number, not a string', () => {
    // A string here would fail `input_default_type_mismatch` at save.
    render(<Harness initialInputs={{ type: 'object', properties: { snoozeHours: { type: 'number' } } }} />)

    fireEvent.change(screen.getByLabelText('Default value for snoozeHours'), { target: { value: '12' } })

    expect(state().inputs.properties.snoozeHours.default).toBe(12)
  })

  it('clears the default instead of storing an empty value', () => {
    render(<Harness initialInputs={{
      type: 'object',
      properties: { timeZone: { type: 'string', default: 'UTC' } },
    }} />)

    fireEvent.change(screen.getByLabelText('Default value for timeZone'), { target: { value: '' } })

    expect(state().inputs.properties.timeZone).toEqual({ type: 'string' })
    expect('default' in state().inputs.properties.timeZone).toBe(false)
  })

  it('distinguishes an unset boolean default from false', () => {
    render(<Harness initialInputs={{ type: 'object', properties: { notify: { type: 'boolean' } } }} />)
    const select = screen.getByLabelText('Default value for notify')

    fireEvent.change(select, { target: { value: 'false' } })
    expect(state().inputs.properties.notify.default).toBe(false)

    fireEvent.change(select, { target: { value: '' } })
    expect('default' in state().inputs.properties.notify).toBe(false)
  })

  it('drops a stale default when the field type changes', () => {
    // '09:00' is meaningless once the field is a number; keeping it would
    // fail validation at save with no obvious cause.
    render(<Harness initialInputs={{
      type: 'object',
      properties: { start: { type: 'string', default: '09:00' } },
    }} />)

    fireEvent.change(screen.getByLabelText('Type for input start'), { target: { value: 'number' } })

    expect(state().inputs.properties.start).toEqual({ type: 'number' })
  })

  it('offers no inline default for object and array fields', () => {
    render(<Harness initialInputs={{
      type: 'object',
      properties: { window: { type: 'object', properties: {} } },
    }} />)

    expect(screen.queryByLabelText('Default value for window')).not.toBeInTheDocument()
  })
})
