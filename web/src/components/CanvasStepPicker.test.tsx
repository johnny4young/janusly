import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasStepPicker } from './CanvasStepPicker'

describe('<CanvasStepPicker />', () => {
  it('releases the canvas and closes the picker after a drag finishes', () => {
    render(<CanvasStepPicker onAddNode={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }))

    const menu = screen.getByRole('dialog', { name: 'Add a step' })
    const step = screen.getByRole('button', { name: /^AI prompt/ })
    fireEvent.dragStart(step, {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: 'copy',
      },
    })
    expect(menu).toHaveAttribute('data-dragging', 'true')

    fireEvent.dragEnd(step)
    expect(screen.queryByRole('dialog', { name: 'Add a step' })).not.toBeInTheDocument()
  })
})
