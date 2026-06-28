import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasErrorBoundary } from './CanvasErrorBoundary'

function Boom(): never {
  throw new Error('boom')
}

describe('<CanvasErrorBoundary />', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders children when they do not throw', () => {
    render(
      <CanvasErrorBoundary fallback={<div>fallback</div>}>
        <div>healthy canvas</div>
      </CanvasErrorBoundary>,
    )
    expect(screen.getByText('healthy canvas')).toBeInTheDocument()
    expect(screen.queryByText('fallback')).not.toBeInTheDocument()
  })

  it('renders the fallback when a child throws during render', () => {
    // React logs the caught error to console.error; silence it for a clean run.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <CanvasErrorBoundary fallback={<div>fallback shown</div>}>
        <Boom />
      </CanvasErrorBoundary>,
    )
    expect(screen.getByText('fallback shown')).toBeInTheDocument()
  })

  it('clears a tripped fallback when resetKey changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(
      <CanvasErrorBoundary fallback={<div>fallback shown</div>} resetKey="wf-1">
        <Boom />
      </CanvasErrorBoundary>,
    )
    expect(screen.getByText('fallback shown')).toBeInTheDocument()

    // Switching workflows (resetKey changes) recovers the boundary without a
    // remount, so the new healthy children render instead of the stale fallback.
    rerender(
      <CanvasErrorBoundary fallback={<div>fallback shown</div>} resetKey="wf-2">
        <div>recovered canvas</div>
      </CanvasErrorBoundary>,
    )
    expect(screen.getByText('recovered canvas')).toBeInTheDocument()
    expect(screen.queryByText('fallback shown')).not.toBeInTheDocument()
  })
})
