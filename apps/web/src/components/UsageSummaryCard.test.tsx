/**
 * Tests for the `UsageSummaryCard` panel — the existing flat
 * `Record<metric, quantity>` summary remains, with a new chip-driven
 * breakdown that fetches `/billing/usage?breakdown=...` when one or
 * more dimensions are active.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { UsageSummaryCard } from './UsageSummaryCard'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const initialState = useWorkflowStore.getState()

const sampleUsage = { 'llm.completion': 12345, 'email.sent': 7 }

const sampleBreakdown = [
  {
    key: 'provider=anthropic',
    provider: 'anthropic',
    quantity: 8000,
    callCount: 50,
    fallbackCount: 2,
    costUsd: 1.20,
    latency: { p50Ms: 800, p95Ms: 2400, avgMs: 1100 },
  },
  {
    key: 'provider=openai',
    provider: 'openai',
    quantity: 4000,
    callCount: 12,
    fallbackCount: 0,
    costUsd: 0.95,
    latency: { p50Ms: 1500, p95Ms: 3100, avgMs: 1800 },
  },
]

describe('<UsageSummaryCard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState(
      {
        ...initialState,
        toasts: [],
        platformVersion: 0,
        userId: 'dev-user',
        orgId: 'default',
      },
      true,
    )
  })

  it('renders the flat summary mini-grid by default with no breakdown visible', () => {
    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={() => undefined} />)

    expect(screen.getByText('llm.completion')).toBeInTheDocument()
    expect(screen.getByText('email.sent')).toBeInTheDocument()
    expect(screen.queryByLabelText('Usage breakdown buckets')).not.toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  it('shows the empty state when usage is empty', () => {
    render(<UsageSummaryCard usage={{}} onRefreshPlatform={() => undefined} />)
    expect(screen.getByText(/No usage recorded yet/i)).toBeInTheDocument()
  })

  it('fetches the breakdown when a chip is activated', async () => {
    vi.mocked(api).mockResolvedValue({ summary: sampleUsage, breakdown: sampleBreakdown, windowDays: 30 })

    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: 'Provider', pressed: false }))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/billing/usage?breakdown=provider')
    })
    expect(await screen.findByLabelText('Usage breakdown buckets')).toBeInTheDocument()
    expect(screen.getByText('anthropic')).toBeInTheDocument()
    expect(screen.getByText('openai')).toBeInTheDocument()
  })

  it('sends a comma-separated dimension list when multiple chips are active', async () => {
    vi.mocked(api).mockResolvedValue({ summary: sampleUsage, breakdown: [], windowDays: 30 })

    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: 'Provider', pressed: false }))
    fireEvent.click(await screen.findByRole('button', { name: 'Model', pressed: false }))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/billing/usage?breakdown=provider%2Cmodel')
    })
  })

  it('sorts buckets by costUsd desc and pushes null-cost rows to the bottom', async () => {
    const mixedBreakdown = [
      { ...sampleBreakdown[0]!, costUsd: 0.50 },
      { ...sampleBreakdown[1]!, costUsd: null, key: 'provider=ollama', provider: 'ollama' },
      { ...sampleBreakdown[0]!, costUsd: 2.00, key: 'provider=mistral', provider: 'mistral' },
    ]
    vi.mocked(api).mockResolvedValue({ summary: sampleUsage, breakdown: mixedBreakdown, windowDays: 30 })

    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Provider', pressed: false }))

    const rows = await screen.findAllByRole('listitem')
    // First should be mistral ($2.00), then anthropic ($0.50), ollama (null) last.
    expect(rows[0]?.textContent).toContain('mistral')
    expect(rows[1]?.textContent).toContain('anthropic')
    expect(rows[2]?.textContent).toContain('ollama')
  })

  it('shows the "+ N more" affordance when more than 10 buckets exist and reveals all when clicked', async () => {
    const many = Array.from({ length: 13 }, (_, idx) => ({
      key: `provider=p${idx}`,
      provider: `p${idx}`,
      quantity: 100,
      callCount: 1,
      fallbackCount: 0,
      costUsd: 1.0 - idx * 0.01,
      latency: { p50Ms: 100, p95Ms: 200, avgMs: 150 },
    }))
    vi.mocked(api).mockResolvedValue({ summary: sampleUsage, breakdown: many, windowDays: 30 })

    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Provider', pressed: false }))

    await screen.findByLabelText('Usage breakdown buckets')
    // 10 visible + 1 "more" button = 11 listitems.
    const beforeRows = screen.getAllByRole('listitem')
    expect(beforeRows).toHaveLength(11)
    expect(screen.getByRole('button', { name: /\+ 3 more/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /\+ 3 more/i }))

    const afterRows = screen.getAllByRole('listitem')
    expect(afterRows).toHaveLength(13)
    expect(screen.queryByRole('button', { name: /\+ \d+ more/i })).not.toBeInTheDocument()
  })

  it('clears the breakdown table when the operator deselects all chips', async () => {
    vi.mocked(api).mockResolvedValue({ summary: sampleUsage, breakdown: sampleBreakdown, windowDays: 30 })

    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Provider', pressed: false }))

    await screen.findByLabelText('Usage breakdown buckets')

    // Deactivate the chip — table should clear without a fresh fetch.
    fireEvent.click(screen.getByRole('button', { name: 'Provider', pressed: true }))

    await waitFor(() => {
      expect(screen.queryByLabelText('Usage breakdown buckets')).not.toBeInTheDocument()
    })
  })

  it('refetches the active breakdown when Refresh is clicked', async () => {
    vi.mocked(api).mockResolvedValue({ summary: sampleUsage, breakdown: sampleBreakdown, windowDays: 30 })
    const onRefreshPlatform = vi.fn()

    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={onRefreshPlatform} />)
    fireEvent.click(screen.getByRole('button', { name: 'Provider', pressed: false }))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/billing/usage?breakdown=provider')
    })
    vi.mocked(api).mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(onRefreshPlatform).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/billing/usage?breakdown=provider')
    })
  })

  it('renders the legacy-pre-attribution sentinel as "Legacy" in the workflow dimension', async () => {
    // Backfilled rows (pre-attribution) get `metadata.workflowId =
    // "_legacy_pre_attribution"` from the one-off backfill script.
    // The UI maps the sentinel to "Legacy" so it's visually distinct
    // from genuinely-unattributed rows (which bucket as "unknown").
    const sentinelBreakdown = [
      {
        key: 'workflow=_legacy_pre_attribution',
        workflow: '_legacy_pre_attribution',
        quantity: 12000,
        callCount: 30,
        fallbackCount: 0,
        costUsd: 0.45,
        latency: { p50Ms: 1500, p95Ms: 3000, avgMs: 1800 },
      },
      {
        key: 'workflow=wf-real',
        workflow: 'wf-real',
        quantity: 4000,
        callCount: 8,
        fallbackCount: 0,
        costUsd: 0.20,
        latency: { p50Ms: 800, p95Ms: 2000, avgMs: 1100 },
      },
    ]
    vi.mocked(api).mockResolvedValue({ summary: sampleUsage, breakdown: sentinelBreakdown, windowDays: 30 })

    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Workflow', pressed: false }))

    await screen.findByLabelText('Usage breakdown buckets')
    expect(screen.getByText('Legacy')).toBeInTheDocument()
    expect(screen.queryByText('_legacy_pre_attribution')).not.toBeInTheDocument()
    expect(screen.getByText('wf-real')).toBeInTheDocument()
  })

  it('surfaces a toast when the breakdown fetch throws', async () => {
    vi.mocked(api).mockRejectedValue(new Error('Janusly API is offline'))
    const addToast = vi.fn()
    useWorkflowStore.setState({ addToast }, false)

    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Provider', pressed: false }))

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith('Janusly API is offline', 'error')
    })
  })

  it('shows "No buckets in this window." when the API returns an empty breakdown', async () => {
    vi.mocked(api).mockResolvedValue({ summary: sampleUsage, breakdown: [], windowDays: 30 })

    render(<UsageSummaryCard usage={sampleUsage} onRefreshPlatform={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Provider', pressed: false }))

    expect(await screen.findByText(/No buckets in this window/i)).toBeInTheDocument()
  })
})
