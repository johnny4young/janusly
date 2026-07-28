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

describe('<CommandPalette /> fuzzy search', () => {
  it('finds a workflow by non-contiguous characters', () => {
    render(<CommandPalette {...props({
      workflows: [{ id: 'refund-triage', name: 'Refund triage Exploit' }],
    })} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'rftx' } })

    expect(screen.getByRole('option', { name: /Refund triage Exploit/ })).toBeInTheDocument()
  })

  it('ranks an exact command match above a fuzzy workflow match', () => {
    render(<CommandPalette {...props({
      workflows: [{ id: 'refund-enrichment', name: 'Risk evaluation for urgent nightly delivery' }],
    })} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'run' } })

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('Run workflow')
  })

  it('caps queried results at five', () => {
    render(<CommandPalette {...props({
      workflows: Array.from({ length: 8 }, (_, index) => ({ id: `flow-${index}`, name: `Flow ${index}` })),
    })} />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flow' } })

    expect(screen.getAllByRole('option')).toHaveLength(5)
  })

  it('resets the active result when a new query reorders the same result count', () => {
    render(<CommandPalette {...props({
      workflows: [
        { id: 'alpha-beta', name: 'Alpha beta' },
        { id: 'beta-alpha', name: 'Beta alpha' },
      ],
    })} />)
    const input = screen.getByRole('combobox')

    fireEvent.change(input, { target: { value: 'alpha' } })
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option').filter(option => option.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(screen.getAllByRole('option').find(option => option.getAttribute('aria-selected') === 'true')).not.toBe(
      screen.getAllByRole('option')[0],
    )

    fireEvent.change(input, { target: { value: 'beta' } })

    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Beta alpha')
    expect(input).toHaveAttribute('aria-controls', 'janusly-command-palette-options')
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]?.id)
  })
})

describe('<CommandPalette /> effective permissions', () => {
  it('omits inaccessible navigation and mutation commands', () => {
    render(<CommandPalette {...props({
      permissions: ['workflows.read'],
      workflows: [{ id: 'flow-1', name: 'Readable workflow' }],
    })} />)

    expect(screen.getByText('Go to Workflows')).toBeInTheDocument()
    expect(screen.getByText('Readable workflow')).toBeInTheDocument()
    expect(screen.queryByText('Go to Home')).not.toBeInTheDocument()
    expect(screen.queryByText('Save workflow')).not.toBeInTheDocument()
    expect(screen.queryByText('Run workflow')).not.toBeInTheDocument()
  })

  it('keeps four destinations first-class while retaining permitted deep jumps', () => {
    render(<CommandPalette {...props({
      permissions: [
        'recovery.read',
        'workflows.read',
        'runs.read',
        'credentials.read',
      ],
    })} />)

    expect(screen.getByText('Go to Home')).toBeInTheDocument()
    expect(screen.getByText('Go to Workflows')).toBeInTheDocument()
    expect(screen.getByText('Go to Activity')).toBeInTheDocument()
    expect(screen.getByText('Go to Settings')).toBeInTheDocument()
    expect(screen.getByText('Go to Recover')).toBeInTheDocument()
    expect(screen.getByText('Go to Connections')).toBeInTheDocument()
  })
})
