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

describe('<CommandPalette /> docs capability', () => {
  it('omits the Docs command when no URL is configured', () => {
    render(<CommandPalette {...props()} />)
    expect(screen.queryByText('Open documentation')).not.toBeInTheDocument()
  })

  it('omits the Docs command when the configured value is not safe HTTPS', () => {
    render(<CommandPalette {...props({ docsUrl: 'http://docs.example.com' })} />)
    expect(screen.queryByText('Open documentation')).not.toBeInTheDocument()
  })

  it('opens configured Docs with isolated-window flags', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const onClose = vi.fn()
    render(<CommandPalette {...props({ docsUrl: 'https://docs.example.com', onClose })} />)

    const label = screen.getByText('Open documentation')
    fireEvent.mouseDown(label.closest('[role="option"]')!)

    expect(open).toHaveBeenCalledWith('https://docs.example.com/', '_blank', 'noopener,noreferrer')
    expect(onClose).toHaveBeenCalledOnce()
  })
})
