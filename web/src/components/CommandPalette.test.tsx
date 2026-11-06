import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { changeAppLanguage } from '../i18n'
import { readRunSummaryPage } from '../lib/list-contract'
import { CommandPalette, type CommandPaletteProps } from './CommandPalette'

vi.mock('../lib/list-contract', () => ({ readRunSummaryPage: vi.fn() }))

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

describe('<CommandPalette /> run filters', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
  const flaky = { id: 'demo-flaky-ingest', name: 'Demo · flaky ingest' }
  const recent = { id: 'run-recent-0001', workflowId: flaky.id, workflowName: flaky.name, status: 'failed', createdAt: hoursAgo(1) }
  const old = { id: 'run-old-000002', workflowId: flaky.id, workflowName: flaky.name, status: 'failed', createdAt: hoursAgo(24 * 5) }

  function runProps(overrides: Partial<CommandPaletteProps> = {}) {
    return props({
      workflows: [flaky],
      onOpenRun: vi.fn(),
      onOpenRecovery: vi.fn(),
      recoveryTargets: [{ id: 'dlq-1', runId: recent.id }],
      permissions: ['runs.read', 'dlq.read', 'dlq.replay'],
      ...overrides,
    })
  }

  it('turns a sentence into editable chips and lists only runs inside the window', async () => {
    vi.mocked(readRunSummaryPage).mockResolvedValue([recent, old])
    const onOpenRun = vi.fn()
    const onClose = vi.fn()
    render(<CommandPalette {...runProps({ onOpenRun, onClose })} />)
    const input = screen.getByRole('combobox')

    fireEvent.change(input, { target: { value: 'failed runs of demo-flaky-ingest since yesterday maybe' } })

    expect(screen.getByTestId('palette-chip-status')).toBeInTheDocument()
    expect(screen.getByTestId('palette-chip-workflow')).toBeInTheDocument()
    expect(screen.getByTestId('palette-chip-time')).toBeInTheDocument()
    expect(screen.getByTestId('palette-unparsed')).toHaveTextContent('Not understood: maybe')
    expect(await screen.findByTestId(`palette-run-${recent.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`palette-run-${old.id}`)).not.toBeInTheDocument()
    expect(vi.mocked(readRunSummaryPage)).toHaveBeenCalledWith(
      '/runs?limit=25&status=failed&workflowId=demo-flaky-ingest',
      expect.any(AbortSignal),
    )

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpenRun).toHaveBeenCalledWith(recent.id)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('edits and removes chips by rewriting the query', async () => {
    vi.mocked(readRunSummaryPage).mockResolvedValue([])
    render(<CommandPalette {...runProps()} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'failed runs of demo-flaky-ingest' } })

    fireEvent.change(screen.getByTestId('palette-chip-select-status'), { target: { value: 'succeeded' } })
    expect(input).toHaveValue('succeeded runs of demo-flaky-ingest')

    fireEvent.click(screen.getByTestId('palette-chip-remove-workflow'))
    expect(input).toHaveValue('succeeded runs of')
    expect(input).toHaveFocus()
    expect(screen.queryByTestId('palette-chip-workflow')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('palette-runs-state')).toHaveTextContent('No runs match these filters.'))
  })

  it('hands replay to the recovery queue without writing, and only with the replay grant', async () => {
    vi.mocked(readRunSummaryPage).mockResolvedValue([recent])
    const onOpenRecovery = vi.fn()
    const { unmount } = render(<CommandPalette {...runProps({ onOpenRecovery })} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'failed runs' } })

    const replay = await screen.findByTestId(`palette-replay-${recent.id}`)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', replay.id)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpenRecovery).toHaveBeenCalledWith('dlq-1')
    unmount()

    render(<CommandPalette {...runProps({ permissions: ['runs.read', 'dlq.read'] })} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'failed runs' } })
    expect(await screen.findByTestId(`palette-run-${recent.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`palette-replay-${recent.id}`)).not.toBeInTheDocument()
  })

  it('pages older runs with the keyset cursor', async () => {
    const page = Array.from({ length: 25 }, (_, index) => ({ ...recent, id: `run-${String(index).padStart(3, '0')}`, createdAt: hoursAgo(index + 1) }))
    vi.mocked(readRunSummaryPage).mockResolvedValueOnce(page).mockResolvedValueOnce([old]).mockResolvedValue(page)
    render(<CommandPalette {...runProps({ recoveryTargets: [] })} />)
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'failed runs' } })

    fireEvent.mouseDown(await screen.findByTestId('palette-runs-more'))

    expect(await screen.findByTestId(`palette-run-${old.id}`)).toBeInTheDocument()
    const last = page[24]
    expect(vi.mocked(readRunSummaryPage)).toHaveBeenLastCalledWith(
      `/runs?limit=25&status=failed&before=${encodeURIComponent(`${last.createdAt}|${last.id}`)}`,
      expect.any(AbortSignal),
    )

    // A changed query starts again from the newest page.
    fireEvent.change(input, { target: { value: 'failed runs today' } })
    fireEvent.change(input, { target: { value: 'failed runs' } })
    await waitFor(() => expect(screen.queryByTestId(`palette-run-${old.id}`)).not.toBeInTheDocument())
    expect(await screen.findByTestId('palette-run-run-000')).toBeInTheDocument()
    expect(vi.mocked(readRunSummaryPage)).toHaveBeenLastCalledWith('/runs?limit=25&status=failed', expect.any(AbortSignal))
  })

  it('stays a command search without the runs grant', () => {
    vi.mocked(readRunSummaryPage).mockClear()
    render(<CommandPalette {...runProps({ permissions: ['workflows.read'] })} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'failed runs' } })
    expect(screen.queryByTestId('palette-run-filters')).not.toBeInTheDocument()
    expect(readRunSummaryPage).not.toHaveBeenCalled()
  })

  it('parses and labels Spanish queries', async () => {
    vi.mocked(readRunSummaryPage).mockResolvedValue([recent])
    try {
      await act(async () => { await changeAppLanguage('es') })
      render(<CommandPalette {...runProps()} />)
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ejecuciones fallidas de demo-flaky-ingest desde ayer' } })
      expect(screen.getByRole('group', { name: 'Entendido como' })).toBeInTheDocument()
      expect(screen.getByLabelText('Quitar el filtro Rango de tiempo')).toBeInTheDocument()
      await waitFor(() => expect(screen.getByTestId(`palette-replay-${recent.id}`)).toHaveTextContent('Reintentar la ejecución run-rece… en Recuperar'))
    } finally {
      await act(async () => { await changeAppLanguage('en') })
    }
  })
})
