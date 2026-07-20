import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommandPalette, type CommandPaletteProps } from './CommandPalette'

function props(overrides: Partial<CommandPaletteProps> = {}): CommandPaletteProps {
  return {
    open: true,
    onClose: vi.fn(),
    openTab: vi.fn(),
    onValidate: vi.fn(),
    onSave: vi.fn(),
    onStart: vi.fn(),
    onNew: vi.fn(),
    onSignOut: vi.fn(),
    onInsertSnippet: vi.fn(),
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('Docs capability (browser)', () => {
  it('renders and safely opens configured documentation in Chromium', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<CommandPalette {...props({ docsUrl: 'https://docs.example.com' })} />)

    const label = screen.getByText('Open documentation')
    expect(label.getBoundingClientRect().height).toBeGreaterThan(0)
    fireEvent.mouseDown(label.closest('[role="option"]')!)
    expect(open).toHaveBeenCalledWith('https://docs.example.com/', '_blank', 'noopener,noreferrer')
  })

  it('does not render a dead Docs command without the capability', () => {
    render(<CommandPalette {...props()} />)
    expect(screen.queryByText('Open documentation')).not.toBeInTheDocument()
  })
})
