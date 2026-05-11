import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HumanFormDialog } from './HumanFormDialog'

const schema = {
  type: 'object' as const,
  properties: {
    requester: { type: 'string' as const, description: 'Employee name' },
    days: { type: 'number' as const },
  },
  required: ['requester', 'days'],
}

describe('<HumanFormDialog />', () => {
  it('renders operator-friendly copy and submits parsed form values', () => {
    const onSubmit = vi.fn()
    render(
      <HumanFormDialog
        title="PTO request"
        description="Collect the details before continuing."
        schema={schema}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText('Form step')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'PTO request' })).toBeInTheDocument()
    expect(screen.getByText('Collect the details before continuing.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/requester/i), { target: { value: 'Ada' } })
    fireEvent.change(screen.getByLabelText(/days/i), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /Submit form/i }))

    expect(onSubmit).toHaveBeenCalledWith({ requester: 'Ada', days: 3 })
  })

  it('keeps the submit action disabled while submitting and maps server errors', () => {
    render(
      <HumanFormDialog
        title="Access review"
        schema={schema}
        serverErrors={['$.requester is required']}
        submitting
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Submitting/i })).toBeDisabled()
    expect(screen.getByText(/requester is required/i)).toBeInTheDocument()
  })

  it('uses clear fallback copy when metadata omits optional title and description', () => {
    render(
      <HumanFormDialog
        schema={schema}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Complete form' })).toBeInTheDocument()
    expect(screen.getByText(/Submit the requested fields/i)).toBeInTheDocument()
  })
})
