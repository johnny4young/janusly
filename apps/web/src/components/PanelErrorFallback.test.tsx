/**
 * Blast-radius test for the panel boundary.
 *
 * The regression this guards against was observed for real: a Recovery Center
 * section dereferenced an unexpected `/recovery/validation` envelope and the
 * THROW unmounted the whole app — the page went blank, not just that card.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from './ErrorBoundary'
import { PanelErrorFallback } from './PanelErrorFallback'

function BadPanel(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'totals')")
}

/** Mirrors how `RightPanel` / `App` mount a panel next to persistent chrome. */
function Workspace({ tab, children }: { tab: string; children: React.ReactNode }) {
  return (
    <div>
      <nav>workspace navigation</nav>
      <ErrorBoundary
        resetKey={tab}
        logTag={`panel:${tab}`}
        fallback={({ reset }) => <PanelErrorFallback onRetry={reset} />}
      >
        {children}
      </ErrorBoundary>
    </div>
  )
}

describe('panel error boundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps the rest of the workspace mounted when a panel throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<Workspace tab="home"><BadPanel /></Workspace>)

    // The panel is replaced, the surrounding chrome survives.
    expect(screen.getByTestId('panel-error-fallback')).toBeInTheDocument()
    expect(screen.getByText('workspace navigation')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('re-renders the panel in place when the operator retries', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let broken = true
    function Panel() {
      if (broken) throw new Error('bad payload')
      return <div>recovery center</div>
    }

    render(<Workspace tab="home"><Panel /></Workspace>)
    expect(screen.getByTestId('panel-error-fallback')).toBeInTheDocument()

    // The next poll returned a healthy payload; retry must not need a reload.
    broken = false
    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByText('recovery center')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-fallback')).not.toBeInTheDocument()
  })

  it('clears a tripped panel when the operator navigates to another tab', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { rerender } = render(<Workspace tab="home"><BadPanel /></Workspace>)
    expect(screen.getByTestId('panel-error-fallback')).toBeInTheDocument()

    rerender(<Workspace tab="runs"><div>runs panel</div></Workspace>)

    expect(screen.getByText('runs panel')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-error-fallback')).not.toBeInTheDocument()
  })
})
