import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Button } from './Button'
import { FieldStack, FormActions, FormField, FormSection } from './Form'
import { StatusSummary } from './StatusSummary'

describe('semantic UI primitives', () => {
  it('keeps native button behavior and exposes one loading state', () => {
    const onClick = vi.fn()
    const view = render(<Button onClick={onClick} variant="primary">Save</Button>)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).toHaveBeenCalledOnce()

    view.rerender(<Button onClick={onClick} loading loadingLabel="Saving">Save</Button>)
    const loadingButton = screen.getByRole('button', { name: 'Saving' })
    expect(loadingButton).toBeDisabled()
    expect(loadingButton).toHaveAttribute('aria-busy', 'true')
  })

  it('wires labels, hints, and errors to the control without caller-managed ids', () => {
    render(
      <FormField label="Monthly budget" hint="Enter zero to disable." error="Must be positive.">
        {(controlProps) => <input {...controlProps} />}
      </FormField>,
    )

    const input = screen.getByLabelText('Monthly budget')
    const describedBy = input.getAttribute('aria-describedby')?.split(' ') ?? []
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-errormessage')
    expect(describedBy).toHaveLength(2)
    expect(describedBy.every((id) => document.getElementById(id))).toBe(true)
  })

  it('groups related fields and actions with semantic fieldset structure', () => {
    render(
      <FormSection title="Organization budget" description="Applies by default.">
        <input aria-label="Limit" />
        <FormActions><Button>Save changes</Button></FormActions>
      </FormSection>,
    )

    expect(screen.getByRole('group', { name: /Organization budget/ })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeVisible()
  })

  it('supports compact labelled field stacks without adding a second visible heading', () => {
    render(
      <div>
        <h2 id="dialog-title">Create credential</h2>
        <FieldStack labelledBy="dialog-title"><input aria-label="Name" /></FieldStack>
      </div>,
    )

    expect(screen.getByRole('group', { name: 'Create credential' })).toBeVisible()
  })

  it('renders status summaries with explicit live-region semantics only when requested', () => {
    const view = render(<StatusSummary title="Ready" description="All checks passed." tone="success" />)
    expect(screen.getByText('Ready').closest('.ui-status-summary')).not.toHaveAttribute('role')

    view.rerender(<StatusSummary title="Connection failed" tone="danger" role="alert" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Connection failed')
  })
})
