import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { contractApi } from '../../api'
import { changeAppLanguage } from '../../i18n'
import { HomeInvestigationPanel } from './HomeInvestigationPanel'

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  contractApi: vi.fn(),
}))

const investigation = {
  runId: 'run-2222aaaa-failed', nodeId: 'fetch', workflowName: 'Demo ingest',
  signature: 'DNS lookup failed on http node', category: 'network_timeout',
  hypotheses: [
    { id: 'network', verdict: 'validated', reason: 'network_dns', params: { signature: 'DNS lookup failed on http node', count: 2 },
      evidence: [
        { kind: 'failed_step', runId: 'run-2222aaaa-failed', nodeId: 'fetch' },
        { kind: 'similar_failure', runId: 'run-1111bbbb-earlier' },
      ] },
    { id: 'credential', verdict: 'ruled_out', reason: 'credential_unused', params: {}, evidence: [] },
    { id: 'upstream', verdict: 'inconclusive', reason: 'upstream_unwatched', params: {}, evidence: [] },
    { id: 'change', verdict: 'inconclusive', reason: 'change_no_baseline', params: { version: 1 }, evidence: [] },
  ],
  conclusion: 'network',
  action: { kind: 'open_recovery', deadLetterId: 'dlq-9' },
  generatedAt: '2026-11-06T12:00:00Z',
}

function setup(data: unknown = investigation) {
  vi.mocked(contractApi).mockResolvedValue(data as never)
  const handlers = { onClose: vi.fn(), onOpenRun: vi.fn(), onOpenRecoveryQueue: vi.fn() }
  render(<HomeInvestigationPanel runId={investigation.runId} title="Recover 2 related failures" {...handlers} />)
  return handlers
}

describe('<HomeInvestigationPanel />', () => {
  beforeEach(() => { vi.mocked(contractApi).mockReset() })
  afterEach(async () => { await act(async () => { await changeAppLanguage('en') }) })

  it('lists each checked cause with its verdict and opens the cited runs', async () => {
    const { onOpenRun } = setup()

    const steps = await screen.findByTestId('home-investigation-steps')
    expect(vi.mocked(contractApi).mock.calls[0]?.slice(0, 2)).toEqual([
      'GET /runs/{runId}/investigation', `/v1/runs/${investigation.runId}/investigation`,
    ])
    expect(within(steps).getAllByRole('listitem').filter((item) => item.parentElement === steps)).toHaveLength(4)
    expect(screen.getByText('Why does fetch fail on Demo ingest?')).toBeInTheDocument()
    expect(screen.getByTestId('home-investigation-step-network')).toHaveTextContent(
      'Host cannot be reachedValidatedDNS lookup failed on http node · 2 failures in 30 days')
    expect(screen.getByTestId('home-investigation-step-credential')).toHaveTextContent('Ruled outThe step uses no credential')
    expect(screen.getByTestId('home-investigation-step-change')).toHaveTextContent('Inconclusive')
    expect(screen.getByTestId('home-investigation-tab-steps')).toHaveTextContent('Steps4')

    fireEvent.click(screen.getByTestId('home-investigation-evidence-network-run-1111bbbb-earlier'))
    expect(onOpenRun).toHaveBeenCalledWith('run-1111bbbb-earlier')
    expect(screen.getByTestId(`home-investigation-evidence-network-${investigation.runId}`))
      .toHaveTextContent('Step fetch · run run-2222')
  })

  it('switches to the tree with the arrow keys and offers only the gated recovery action', async () => {
    const { onOpenRecoveryQueue, onClose } = setup()
    const stepsTab = await screen.findByTestId('home-investigation-tab-steps')
    await screen.findByTestId('home-investigation-steps')

    fireEvent.keyDown(stepsTab, { key: 'ArrowRight' })
    const treeTab = screen.getByTestId('home-investigation-tab-tree')
    expect(treeTab).toHaveAttribute('aria-selected', 'true')
    expect(treeTab).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', treeTab.id)
    const tree = screen.getByTestId('home-investigation-tree')
    expect(within(tree).getByRole('list', { name: 'Why does fetch fail on Demo ingest?' })).toBeInTheDocument()
    expect(screen.getByTestId('home-investigation-node-network')).toHaveAttribute('data-verdict', 'validated')
    expect(screen.getByTestId('home-investigation-node-upstream')).toHaveTextContent('No upstream status source watches this workflow')
    expect(screen.getByTestId('home-investigation-conclusion')).toHaveTextContent('The step cannot reach its host.')

    fireEvent.click(screen.getByTestId('home-investigation-action'))
    expect(onOpenRecoveryQueue).toHaveBeenCalledWith('dlq-9')

    fireEvent.keyDown(screen.getByTestId('home-investigation-panel'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows no action and says so when nothing is validated', async () => {
    setup({
      ...investigation, conclusion: '', action: null,
      hypotheses: investigation.hypotheses.map((item) => ({ ...item, verdict: 'inconclusive', reason: 'no_error', params: {}, evidence: [] })),
    })
    expect(await screen.findByTestId('home-investigation-conclusion')).toHaveTextContent('No cause was validated.')
    expect(screen.queryByTestId('home-investigation-action')).toBeNull()
  })

  it('reports a failed load without inventing causes', async () => {
    vi.mocked(contractApi).mockRejectedValue(new Error('boom'))
    render(<HomeInvestigationPanel runId="run-x" title="t" onClose={vi.fn()} onOpenRun={vi.fn()} onOpenRecoveryQueue={vi.fn()} />)
    expect(await screen.findByTestId('home-investigation-error')).toBeInTheDocument()
    expect(screen.queryByTestId('home-investigation-steps')).toBeNull()
  })

  it('renders the investigation in Spanish', async () => {
    await act(async () => { await changeAppLanguage('es') })
    setup()
    await screen.findByTestId('home-investigation-steps')
    expect(screen.getByText('¿Por qué falla fetch en Demo ingest?')).toBeInTheDocument()
    expect(screen.getByTestId('home-investigation-step-network')).toHaveTextContent('No se llega al hostConfirmada')
    expect(screen.getByTestId('home-investigation-step-credential')).toHaveTextContent('DescartadaEl paso no usa ninguna credencial')
    expect(screen.getByTestId('home-investigation-action')).toHaveTextContent('Corregir en Recuperar')
  })
})
