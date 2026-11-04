import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('runs a toast action once and removes the toast', () => {
    const onClick = vi.fn()
    useWorkflowStore.setState({ toasts: [{ id: 'c', message: 'Moved', tone: 'success', action: { label: 'Undo', onClick } }] })
    render(<ToastRenderer />)
    fireEvent.click(screen.getByTestId('toast-action'))
    expect(onClick).toHaveBeenCalledOnce()
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })

  it('takes orphaned focus for the action but never steals it', () => {
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    useWorkflowStore.setState({ toasts: [{ id: 'd', message: 'One', tone: 'success', action: { label: 'Undo', onClick: () => {} } }] })
    const first = render(<ToastRenderer />)
    expect(input).toHaveFocus()
    first.unmount()
    input.remove()

    useWorkflowStore.setState({ toasts: [{ id: 'e', message: 'Two', tone: 'success', action: { label: 'Undo', onClick: () => {} } }] })
    render(<ToastRenderer />)
    expect(screen.getByTestId('toast-action')).toHaveFocus()
  })
})
