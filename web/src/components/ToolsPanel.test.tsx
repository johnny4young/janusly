import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { invalidateTags, PLATFORM_TAG } from '../lib/query-cache'
import type { ToolSchema } from '../types'
import { ToolsPanel } from './ToolsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const tool = (name: string, writeSide = false): ToolSchema => ({
  name,
  description: `${name} description`,
  inputFields: [],
  writeSide,
})

const TOOLS = [
  tool('csv.parse'),
  tool('csv.stringify'),
  tool('db.query.read'),
  tool('db.query.write', true),
  tool('db.schema.describe'),
  // The name reads like a write; only the static bit may decide.
  tool('slack.post'),
  tool('standalone', true),
]

function renderPanel(overrides: Partial<Parameters<typeof ToolsPanel>[0]> = {}) {
  const onInstallPlugin = vi.fn().mockResolvedValue(true)
  render(<ToolsPanel tools={TOOLS} onInstallPlugin={onInstallPlugin} canInstall {...overrides} />)
  return { onInstallPlugin }
}

const groupNames = () => screen.queryAllByTestId(/^tools-group-/).map(group => group.getAttribute('aria-label'))

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({ pluginIds: ['csv.parse', 'removed.plugin'] })
})

describe('<ToolsPanel />', () => {
  it('keeps the empty state without a filter bar when no tools exist', async () => {
    renderPanel({ tools: [] })
    expect(screen.getByText('No tools available')).toBeInTheDocument()
    expect(screen.queryByTestId('tools-filter-all')).not.toBeInTheDocument()
    await waitFor(() => expect(api).toHaveBeenCalledWith('/plugins/installed', expect.anything()))
  })

  it('groups by namespace, largest first, and shows names relative to the namespace', async () => {
    renderPanel()
    await screen.findByTestId('tools-installed-csv.parse')
    expect(groupNames()).toEqual(['db', 'csv', 'slack', 'standalone'])
    const db = screen.getByTestId('tools-group-db')
    expect(within(db).getByText('3 tools · 1 write')).toBeInTheDocument()
    expect(within(db).getByTestId('tools-row-db.query.write')).toHaveTextContent('query.write')
    expect(within(screen.getByTestId('tools-group-standalone')).getByText('1 tool · 1 write')).toBeInTheDocument()
    expect(screen.getByTestId('tools-row-standalone')).toHaveTextContent('standalone')
  })

  it('filters on the static write capability, never on the tool name', async () => {
    renderPanel()
    await screen.findByTestId('tools-installed-csv.parse')
    expect(screen.getByTestId('tools-filter-read')).toHaveTextContent('Read-only 5')
    expect(screen.getByTestId('tools-filter-write')).toHaveTextContent('May change external systems 2')

    fireEvent.click(screen.getByTestId('tools-filter-write'))
    expect(screen.getByTestId('tools-filter-write')).toHaveAttribute('aria-pressed', 'true')
    expect(groupNames()).toEqual(['db', 'standalone'])
    expect(screen.queryByTestId('tools-row-slack.post')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tools-row-db.query.read')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('tools-filter-read'))
    expect(screen.getByTestId('tools-row-slack.post')).toBeInTheDocument()
    expect(screen.queryByTestId('tools-row-db.query.write')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('tools-filter-all'))
    expect(groupNames()).toHaveLength(4)
  })

  it('shows install state from the server and counts only catalog tools', async () => {
    renderPanel()
    expect(await screen.findByTestId('tools-installed-csv.parse')).toHaveTextContent('Installed')
    expect(screen.queryByTestId('tools-installed-csv.stringify')).not.toBeInTheDocument()
    expect(screen.getByTestId('tools-filter-installed')).toHaveTextContent('Installed 1')

    fireEvent.click(screen.getByTestId('tools-filter-installed'))
    expect(groupNames()).toEqual(['csv'])
    expect(screen.queryByTestId('tools-row-csv.stringify')).not.toBeInTheDocument()
  })

  it('explains an empty filter result', async () => {
    vi.mocked(api).mockResolvedValue({ pluginIds: [] })
    renderPanel()
    fireEvent.click(await screen.findByTestId('tools-filter-installed'))
    expect(screen.getByTestId('tools-no-matches')).toHaveTextContent('No tools match this filter.')
  })

  it('opens one tool at a time with its description, capability and Install', async () => {
    renderPanel()
    const row = await screen.findByTestId('tools-row-db.query.write')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('db.query.write description')).not.toBeInTheDocument()

    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const details = screen.getByTestId('tools-details-db.query.write')
    expect(within(details).getByText('db.query.write')).toBeInTheDocument()
    expect(within(details).getByText('db.query.write description')).toBeInTheDocument()
    expect(within(details).getByText('May change external systems')).toBeInTheDocument()
    expect(screen.getByTestId('tools-install-db.query.write')).toHaveTextContent('Install tool')

    fireEvent.click(screen.getByTestId('tools-row-csv.stringify'))
    expect(screen.queryByTestId('tools-details-db.query.write')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('tools-row-csv.stringify'))
    expect(screen.queryByTestId('tools-details-csv.stringify')).not.toBeInTheDocument()
  })

  it('replaces Install with the installed state once the install succeeds', async () => {
    let finish: (ok: boolean) => void = () => {}
    const onInstallPlugin = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
    renderPanel({ onInstallPlugin })
    await screen.findByTestId('tools-installed-csv.parse')
    fireEvent.click(screen.getByTestId('tools-row-slack.post'))
    fireEvent.click(screen.getByTestId('tools-install-slack.post'))
    expect(onInstallPlugin).toHaveBeenCalledWith('slack.post')
    expect(screen.getByTestId('tools-install-slack.post')).toBeDisabled()
    // Clearing a single in-flight marker would otherwise re-enable a second tool's pending install.
    fireEvent.click(screen.getByTestId('tools-row-csv.stringify'))
    expect(screen.getByTestId('tools-install-csv.stringify')).toBeDisabled()
    fireEvent.click(screen.getByTestId('tools-row-slack.post'))

    await act(async () => finish(true))
    expect(screen.getByTestId('tools-installed-slack.post')).toBeInTheDocument()
    expect(screen.queryByTestId('tools-install-slack.post')).not.toBeInTheDocument()
    expect(screen.getByTestId('tools-filter-installed')).toHaveTextContent('Installed 2')
  })

  it('keeps Install available when the install fails', async () => {
    renderPanel({ onInstallPlugin: vi.fn().mockResolvedValue(false) })
    await screen.findByTestId('tools-installed-csv.parse')
    fireEvent.click(screen.getByTestId('tools-row-slack.post'))
    await act(async () => { fireEvent.click(screen.getByTestId('tools-install-slack.post')) })
    expect(screen.getByTestId('tools-install-slack.post')).toBeEnabled()
    expect(screen.queryByTestId('tools-installed-slack.post')).not.toBeInTheDocument()
  })

  it('keeps Install disabled without the write permission', async () => {
    renderPanel({ canInstall: false })
    fireEvent.click(await screen.findByTestId('tools-row-slack.post'))
    expect(screen.getByTestId('tools-install-slack.post')).toBeDisabled()
  })

  it.each([
    ['a rejected read', () => vi.mocked(api).mockRejectedValue(new Error('nope'))],
    ['a malformed read', () => vi.mocked(api).mockResolvedValue({ plugins: [] })],
  ])('says install state is unknown after %s and leaves Install usable', async (_label, arrange) => {
    arrange()
    renderPanel()
    expect(await screen.findByTestId('tools-installed-error')).toHaveTextContent('Install state could not be loaded.')
    expect(screen.queryByTestId('tools-filter-installed')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('tools-row-slack.post'))
    expect(screen.getByTestId('tools-install-slack.post')).toBeEnabled()
  })

  it('re-reads install state when platform data is invalidated', async () => {
    renderPanel()
    await screen.findByTestId('tools-installed-csv.parse')
    vi.mocked(api).mockResolvedValue({ pluginIds: ['csv.stringify'] })
    await act(async () => invalidateTags([PLATFORM_TAG]))
    expect(await screen.findByTestId('tools-installed-csv.stringify')).toBeInTheDocument()
    expect(screen.queryByTestId('tools-installed-csv.parse')).not.toBeInTheDocument()
  })
})
