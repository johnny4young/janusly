import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceArea } from './WorkspaceArea'

const neverReady = new Promise<never>(() => {})

function SuspendedContent(): never {
  throw neverReady
}

function BrokenContent(): never {
  throw new Error('workspace chunk failed')
}

describe('<WorkspaceArea />', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps surrounding shell content mounted while an area is loading', () => {
    render(
      <div data-testid="shell">
        <span>Persistent navigation</span>
        <WorkspaceArea resetKey="operations" logTag="workspace-main:operations">
          <SuspendedContent />
        </WorkspaceArea>
      </div>,
    )

    expect(screen.getByTestId('shell')).toHaveTextContent('Persistent navigation')
    expect(screen.getByTestId('workspace-content-loading')).toHaveAttribute(
      'aria-label',
      'Working…',
    )
  })

  it('contains a workspace-area render failure and offers an in-place retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <div data-testid="shell">
        <span>Persistent navigation</span>
        <WorkspaceArea resetKey="operations" logTag="workspace-main:operations">
          <BrokenContent />
        </WorkspaceArea>
      </div>,
    )

    expect(screen.getByTestId('shell')).toHaveTextContent('Persistent navigation')
    expect(screen.getByTestId('panel-error-fallback')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
