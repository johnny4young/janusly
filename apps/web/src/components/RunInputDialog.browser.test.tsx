import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { WorkflowInputSchemaShape } from '../types'
import { RunInputDialog } from './RunInputDialog'

const INPUTS: WorkflowInputSchemaShape = {
  type: 'object',
  properties: {
    invoiceId: {
      type: 'string',
      description: 'The invoice to process.',
    },
    retry_count: {
      type: 'number',
      default: 3,
    },
    notifyCustomer: {
      type: 'boolean',
      description: 'Send the result to the customer.',
    },
  },
  required: ['invoiceId', 'notifyCustomer'],
}

describe('<RunInputDialog /> browser smoke', () => {
  it('presents aligned readable fields and submits explicit operator choices', async () => {
    const onSubmit = vi.fn()
    render(
      <RunInputDialog
        inputs={INPUTS}
        workflowName="Invoice follow-up"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    const invoice = screen.getByRole('textbox', { name: 'Invoice ID' })
    const retries = screen.getByRole('spinbutton', { name: 'Retry Count' })
    const notify = screen.getByRole('combobox', { name: 'Notify Customer' })
    expect(invoice).toHaveFocus()
    expect(retries).toHaveValue(3)
    expect(notify).toHaveValue('')
    expect(screen.getAllByText('Required')).toHaveLength(2)
    expect(screen.getAllByText('Optional')).toHaveLength(1)

    const controlBounds = [invoice, retries, notify].map((control) => control.getBoundingClientRect())
    expect(controlBounds.every(({ width, height }) => width > 300 && height > 0)).toBe(true)
    expect(Math.max(...controlBounds.map(({ left }) => left))
      - Math.min(...controlBounds.map(({ left }) => left))).toBeLessThanOrEqual(1)
    expect(Math.max(...controlBounds.map(({ right }) => right))
      - Math.min(...controlBounds.map(({ right }) => right))).toBeLessThanOrEqual(1)

    fireEvent.change(invoice, { target: { value: 'INV-42' } })
    fireEvent.change(notify, { target: { value: 'false' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run workflow' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        invoiceId: 'INV-42',
        retry_count: 3,
        notifyCustomer: false,
      })
    })
  })
})
