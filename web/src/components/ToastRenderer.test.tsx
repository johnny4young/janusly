import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkflowStore } from '../store'
import { ToastRenderer } from './ToastRenderer'

describe('<ToastRenderer />', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ toasts: [] })
  })

  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastRenderer />)
    expect(container.firstChild).toBeNull()
  })

  it('renders toasts and removes them on click', () => {
    useWorkflowStore.setState({ toasts: [{ id: 'a', message: 'Saved', tone: 'success' }] })
    render(<ToastRenderer />)
    const toast = screen.getByRole('button', { name: 'Saved' })
    expect(toast.className).toContain('toast-success')
    fireEvent.click(toast)
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

  it('applies the error tone class', () => {
    useWorkflowStore.setState({ toasts: [{ id: 'b', message: 'Boom', tone: 'error' }] })
    render(<ToastRenderer />)
    expect(screen.getByRole('button', { name: 'Boom' }).className).toContain('toast-error')
  })
})
