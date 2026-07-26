import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function Boom(): never {
  throw new Error('boom')
}

describe('<ErrorBoundary />', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders children when they do not throw', () => {
    render(
      <ErrorBoundary fallback={<div>fallback</div>}>
        <div>healthy canvas</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('healthy canvas')).toBeInTheDocument()
    expect(screen.queryByText('fallback')).not.toBeInTheDocument()
  })

  it('renders the fallback when a child throws during render', () => {
    // React logs the caught error to console.error; silence it for a clean run.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary fallback={<div>fallback shown</div>}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('fallback shown')).toBeInTheDocument()
  })

  it('clears a tripped fallback when resetKey changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = render(
      <ErrorBoundary fallback={<div>fallback shown</div>} resetKey="wf-1">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText('fallback shown')).toBeInTheDocument()

    // Switching workflows (resetKey changes) recovers the boundary without a
    // remount, so the new healthy children render instead of the stale fallback.
    rerender(
      <ErrorBoundary fallback={<div>fallback shown</div>} resetKey="wf-2">
        <div>recovered canvas</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('recovered canvas')).toBeInTheDocument()
    expect(screen.queryByText('fallback shown')).not.toBeInTheDocument()
  })

  it('lets a render-prop fallback retry in place without changing resetKey', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A panel usually trips on one bad payload; the next render is healthy.
    let shouldThrow = true
    function Flaky() {
      if (shouldThrow) throw new Error('bad payload')
      return <div>panel recovered</div>
    }

    render(
      <ErrorBoundary
        resetKey="runs"
        fallback={({ reset }) => <button type="button" onClick={reset}>retry</button>}
      >
        <Flaky />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument()

    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))

    expect(screen.getByText('panel recovered')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'retry' })).not.toBeInTheDocument()
  })

  it('tags the diagnostic line with the owning surface', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary fallback={<div>fallback</div>} logTag="panel:runs">
        <Boom />
      </ErrorBoundary>,
    )
    expect(consoleError.mock.calls.some(([first]) =>
      String(first).includes('[panel:runs] render error caught by boundary'))).toBe(true)
  })
})
