import { useInvalidationNonce } from '../lib/query-cache'
import { configure, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { BudgetSettingsPanel } from './BudgetSettingsPanel'

vi.mock('../api', () => {
  const module = ({ api: vi.fn() })
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

// Each row chains two reads before it can paint its meter.
configure({ asyncUtilTimeout: 5000 })

const REFRESH_TAGS = ['billing'] as const
const initialState = useWorkflowStore.getState()

const ORG_ENVELOPE = {
  allowed: true,
  monthlyUsdSpent: 12.5,
  monthlyUsdLimit: 25.5,
  policy: 'block',
  warningPercent: 75,
  warningThresholdCrossed: false,
  exceededAt: null,
  resolvedScope: 'org',
}

const WORKFLOW_ENVELOPE = {
  allowed: true,
  monthlyUsdSpent: 4,
  // float4 storage reads 7.1 back with this tail.
  monthlyUsdLimit: 7.099999904632568,
  policy: 'block',
  warningPercent: 70,
  warningThresholdCrossed: false,
  exceededAt: null,
  resolvedScope: 'workflow',
}

type BudgetApiOptions = {
  monthlyUsd?: number
  orgEnvelope?: object | Error
  workflows?: { id: string; orgId: string; name: string }[] | Error
}

function mockBudgetApi({ monthlyUsd = 25.5, orgEnvelope = ORG_ENVELOPE, workflows }: BudgetApiOptions = {}) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/org/config' && init?.method === 'POST') {
      return JSON.parse(String(init.body))
    }
    if (path === '/org/config') {
      return {
        config: [
          { key: 'ai.budgetMonthlyUsd', value: monthlyUsd, source: 'db' },
          { key: 'ai.budgetWarnPercent', value: 75, source: 'db' },
          { key: 'ai.budgetExceededPolicy', value: 'block', source: 'db' },
        ],
      }
    }
    if (path === '/billing/budget') {
      if (orgEnvelope instanceof Error) throw orgEnvelope
      return orgEnvelope
    }
    if (path === '/workflows') {
      if (workflows instanceof Error) throw workflows
      return workflows ?? [
        { id: 'wf_1', orgId: 'default', name: 'Refund triage' },
        { id: 'wf_2', orgId: 'default', name: 'Nightly report' },
      ]
    }
    if (path.startsWith('/billing/budget?workflowId=wf_1')) return WORKFLOW_ENVELOPE
    // A workflow without its own limit reports the org's numbers.
    if (path.startsWith('/billing/budget?workflowId=')) return ORG_ENVELOPE
    if (path === '/workflows/wf_1/budget' && init?.method === 'POST') {
      return { id: 'budget_1', workflowId: 'wf_1', monthlyUsd: 8, warnPercent: 70, policy: 'block' }
    }
    return []
  })
}

function postsTo(path: string) {
  return vi.mocked(api).mock.calls.filter(([calledPath, init]) => calledPath === path && init?.method === 'POST')
}

describe('<BudgetSettingsPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, toasts: [], budgetBlocked: null }, true)
  })

  it('loads org budget values from the /org/config envelope', async () => {
    mockBudgetApi()

    render(<BudgetSettingsPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('budget-org-monthly')).toHaveValue(25.5)
    })
    expect(screen.getByTestId('budget-org-mode-limit')).toBeChecked()
    expect(screen.getByTestId('budget-org-warn')).toHaveValue(75)
    expect(screen.getByTestId('budget-org-policy')).toHaveValue('block')
  })

  it('meters the month to date spend the API returns against the threshold', async () => {
    mockBudgetApi()

    render(<BudgetSettingsPanel />)

    const meter = await screen.findByTestId('budget-org-meter')
    expect(meter).toHaveTextContent('$12.50 of $25.50 this month')
    expect(meter).toHaveTextContent('49%')
    expect(meter).toHaveTextContent('Warning at 75%')
    const bar = within(meter).getByRole('meter')
    expect(bar).toHaveAttribute('aria-valuenow', '12.5')
    expect(bar).toHaveAttribute('aria-valuemax', '25.5')
    expect(bar).toHaveAttribute('aria-valuetext', '$12.50 of $25.50 this month')
  })

  it('caps the bar and names the state once spend passes the limit', async () => {
    mockBudgetApi({
      orgEnvelope: { ...ORG_ENVELOPE, allowed: false, monthlyUsdSpent: 30, warningThresholdCrossed: true, exceededAt: 'org' },
    })

    render(<BudgetSettingsPanel />)

    const meter = await screen.findByTestId('budget-org-meter')
    expect(meter).toHaveAttribute('data-band', 'danger')
    expect(meter).toHaveTextContent('118%')
    expect(meter).toHaveTextContent('Blocking new calls')
    expect(within(meter).getByRole('meter')).toHaveAttribute('aria-valuenow', '25.5')
  })

  it('shows Off without a spend figure: the API does not measure spend without a limit', async () => {
    mockBudgetApi({
      monthlyUsd: 0,
      orgEnvelope: { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, resolvedScope: null },
    })

    render(<BudgetSettingsPanel />)

    expect(await screen.findByTestId('budget-org-off')).toBeInTheDocument()
    expect(screen.getByTestId('budget-org-mode-off')).toBeChecked()
    expect(screen.queryByTestId('budget-org-meter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('budget-org-monthly')).not.toBeInTheDocument()
    expect(screen.getByTestId('budget-settings-panel')).not.toHaveTextContent('$0.00')
  })

  it('says spend is unavailable instead of inventing it when the read fails', async () => {
    mockBudgetApi({ orgEnvelope: new Error('boom') })

    render(<BudgetSettingsPanel />)

    expect(await screen.findByTestId('budget-org-spend-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('budget-org-meter')).not.toBeInTheDocument()
    expect(screen.getByTestId('budget-org-monthly')).toHaveValue(25.5)
  })

  it('stores Off as 0 and leaves the saved warning and policy untouched', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-org-monthly')
    fireEvent.click(screen.getByTestId('budget-org-mode-off'))
    expect(screen.queryByTestId('budget-org-monthly')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('budget-org-save'))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/config', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ key: 'ai.budgetMonthlyUsd', value: 0 }),
      }))
    })
    await waitFor(() => expect(useWorkflowStore.getState().toasts).toHaveLength(1))
    expect(postsTo('/org/config')).toHaveLength(1)
  })

  it('requires an amount of at least a cent to turn the limit on', async () => {
    mockBudgetApi({ monthlyUsd: 0 })
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-org-off')
    expect(screen.getByTestId('budget-org-save')).toBeDisabled()

    fireEvent.click(screen.getByTestId('budget-org-mode-limit'))
    const monthly = screen.getByTestId('budget-org-monthly')
    expect(monthly).toHaveValue(null)
    expect(screen.getByTestId('budget-org-save')).toBeDisabled()

    fireEvent.change(monthly, { target: { value: '0' } })
    expect(screen.getByText('Monthly limit must be at least $0.01')).toBeInTheDocument()
    expect(monthly).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('budget-org-save')).toBeDisabled()

    fireEvent.change(monthly, { target: { value: '5' } })
    expect(screen.getByTestId('budget-org-save')).toBeEnabled()
  })

  it('keeps the amount when switching Off and back before saving', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    fireEvent.change(await screen.findByTestId('budget-org-monthly'), { target: { value: '40' } })
    fireEvent.click(screen.getByTestId('budget-org-mode-off'))
    fireEvent.click(screen.getByTestId('budget-org-mode-limit'))

    expect(screen.getByTestId('budget-org-monthly')).toHaveValue(40)
  })

  it('lists workflows as rows and shows spend only for a workflow with its own limit', async () => {
    mockBudgetApi()

    render(<BudgetSettingsPanel />)

    const own = await screen.findByTestId('budget-workflow-meter-wf_1')
    expect(own).toHaveTextContent('$4.00')
    expect(own).toHaveTextContent('56%')
    const row = screen.getByTestId('budget-workflow-row-wf_1')
    expect(row).toHaveTextContent('Refund triage')
    expect(row).toHaveTextContent('$7.10 / month')
    expect(row).toHaveTextContent('70%')
    expect(row).toHaveTextContent('Block')

    // The envelope carries org spend for this row: it must not read as the workflow's.
    await waitFor(() => expect(screen.getByTestId('budget-workflow-limit-wf_2')).toHaveTextContent('Org-wide'))
    expect(screen.getByTestId('budget-workflow-spent-wf_2')).toHaveTextContent('—')
    expect(screen.getByTestId('budget-workflow-row-wf_2')).not.toHaveTextContent('$12.50')
  })

  it('loads an existing workflow override into all workflow fields', async () => {
    mockBudgetApi()

    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))

    expect(screen.getByTestId('budget-workflow-mode-limit')).toBeChecked()
    expect(screen.getByTestId('budget-workflow-monthly')).toHaveValue(7.1)
    expect(screen.getByTestId('budget-workflow-warn')).toHaveValue(70)
    expect(screen.getByTestId('budget-workflow-policy')).toHaveValue('block')
    expect(screen.getByTestId('budget-workflow-save')).toBeDisabled()
  })

  it('renders the workflow policy options with the descriptive labels, matching the org selector', async () => {
    mockBudgetApi()

    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))

    // The workflow-level policy dropdown must show the same descriptive labels
    // as the org-level selector — not the bare "warn" / "block" key names.
    const wfPolicy = screen.getByTestId('budget-workflow-policy')
    expect(wfPolicy).toHaveTextContent('keep AI calls running')
    expect(wfPolicy).toHaveTextContent('Block new calls at the recorded threshold')
  })

  it('saves a workflow limit from its row and closes the editor', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    fireEvent.change(screen.getByTestId('budget-workflow-monthly'), { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('budget-workflow-save'))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/workflows/wf_1/budget', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ monthlyUsd: 8, warnPercent: 70, policy: 'block' }),
      }))
    })
    await waitFor(() => expect(screen.queryByTestId('budget-workflow-monthly')).not.toBeInTheDocument())
  })

  it('falls a workflow back to the org budget by storing 0, ignoring its open warning and policy fields', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    fireEvent.change(screen.getByTestId('budget-workflow-warn'), { target: { value: '80.5' } })
    fireEvent.click(screen.getByTestId('budget-workflow-mode-off'))
    fireEvent.click(screen.getByTestId('budget-workflow-save'))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/workflows/wf_1/budget', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ monthlyUsd: 0 }),
      }))
    })
  })

  it('has nothing to save for a workflow that stays on the org budget', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    await waitFor(() => expect(screen.getByTestId('budget-workflow-limit-wf_2')).toHaveTextContent('Org-wide'))
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_2'))
    expect(screen.getByTestId('budget-workflow-mode-off')).toBeChecked()
    expect(screen.getByTestId('budget-workflow-save')).toBeDisabled()

    fireEvent.click(screen.getByTestId('budget-workflow-mode-limit'))
    expect(screen.getByTestId('budget-workflow-monthly')).toHaveValue(null)
    expect(screen.getByTestId('budget-workflow-save')).toBeDisabled()
  })

  it('starts a new workflow limit from the warning and policy that govern the workflow now', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    await waitFor(() => expect(screen.getByTestId('budget-workflow-limit-wf_2')).toHaveTextContent('Org-wide'))
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_2'))
    fireEvent.click(screen.getByTestId('budget-workflow-mode-limit'))

    // The org envelope carries warn 75 and block; 80 and warn would silently weaken an org block.
    expect(screen.getByTestId('budget-workflow-warn')).toHaveValue(75)
    expect(screen.getByTestId('budget-workflow-policy')).toHaveValue('block')
  })

  it('discards a row draft on Cancel', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    fireEvent.change(screen.getByTestId('budget-workflow-monthly'), { target: { value: '99' } })
    fireEvent.click(screen.getByTestId('budget-workflow-cancel'))
    expect(screen.queryByTestId('budget-workflow-monthly')).not.toBeInTheDocument()
    expect(screen.getByTestId('budget-workflow-edit-wf_1')).toHaveFocus()

    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    expect(screen.getByTestId('budget-workflow-monthly')).toHaveValue(7.1)
  })

  it('keeps unsaved org edits when a workflow save refreshes the panel', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    fireEvent.change(screen.getByTestId('budget-org-monthly'), { target: { value: '60' } })
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    fireEvent.change(screen.getByTestId('budget-workflow-monthly'), { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('budget-workflow-save'))

    await waitFor(() => expect(postsTo('/workflows/wf_1/budget')).toHaveLength(1))
    const orgReads = () => vi.mocked(api).mock.calls.filter(([path, init]) => path === '/org/config' && !init).length
    await waitFor(() => expect(orgReads()).toBeGreaterThan(1))
    await waitFor(() => expect(screen.getByTestId('budget-org-monthly')).toHaveValue(60))
  })

  it('blocks editing a row whose budget could not be read', async () => {
    mockBudgetApi()
    const healthy = vi.mocked(api).getMockImplementation()!
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('workflowId=wf_2')) throw new Error('boom')
      return healthy(path, init)
    })

    render(<BudgetSettingsPanel />)

    await waitFor(() => expect(screen.getByTestId('budget-workflow-limit-wf_2')).toHaveTextContent('Failed to load budget'))
    expect(screen.getByTestId('budget-workflow-edit-wf_2')).toBeDisabled()
  })

  it('surfaces a failed workflow save in its row', async () => {
    mockBudgetApi()
    const healthy = vi.mocked(api).getMockImplementation()!
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/workflows/wf_1/budget') throw new Error('Nope')
      return healthy(path, init)
    })

    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    fireEvent.change(screen.getByTestId('budget-workflow-monthly'), { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('budget-workflow-save'))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('budget-workflow-monthly')).toHaveValue(8)
  })

  it('reads budgets only for visible rows and reaches the rest through filter and Show more', async () => {
    const workflows = Array.from({ length: 12 }, (_, index) => ({ id: `wf_${index + 10}`, orgId: 'default', name: `Flow ${index + 10}` }))
    mockBudgetApi({ workflows })

    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-row-wf_19')
    expect(screen.queryByTestId('budget-workflow-row-wf_20')).not.toBeInTheDocument()
    const reads = () => vi.mocked(api).mock.calls.filter(([path]) => String(path).includes('workflowId=')).length
    await waitFor(() => expect(reads()).toBe(10))

    fireEvent.click(screen.getByTestId('budget-workflow-more'))
    expect(screen.getByTestId('budget-workflow-row-wf_21')).toBeInTheDocument()
    expect(screen.queryByTestId('budget-workflow-more')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('budget-workflow-filter'), { target: { value: 'flow 21' } })
    expect(screen.getByTestId('budget-workflow-row-wf_21')).toBeInTheDocument()
    expect(screen.queryByTestId('budget-workflow-row-wf_20')).not.toBeInTheDocument()
  })

  it('omits the filter and Show more for a short list', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-table')
    expect(screen.queryByTestId('budget-workflow-filter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('budget-workflow-more')).not.toBeInTheDocument()
  })

  it('tells an empty workflow list apart from a failed one', async () => {
    mockBudgetApi({ workflows: [] })
    const { unmount } = render(<BudgetSettingsPanel />)
    expect(await screen.findByText(/No saved workflows yet/)).toBeInTheDocument()
    unmount()

    mockBudgetApi({ workflows: new Error('boom') })
    render(<BudgetSettingsPanel />)
    expect(await screen.findByText('Failed to load budget')).toBeInTheDocument()
    expect(screen.queryByText(/No saved workflows yet/)).not.toBeInTheDocument()
  })

  it('saves org budget fields through the existing org config route and invalidates dependent resources', async () => {
    const { result: refresh } = renderHook(() => useInvalidationNonce(REFRESH_TAGS))
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    const monthly = await screen.findByTestId('budget-org-monthly')
    fireEvent.change(monthly, { target: { value: '33' } })
    fireEvent.click(screen.getByTestId('budget-org-save'))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/org/config', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ key: 'ai.budgetMonthlyUsd', value: 33 }),
      }))
    })
    await waitFor(() => expect(postsTo('/org/config')).toHaveLength(3))
    // bumpPlatformVersion is debounced (100ms trailing edge) — assert
    // via waitFor so the timer fires under real wallclock during the
    // poll window.
    await waitFor(() => expect(refresh.current).toBe(1))
  })

  it('flags a fractional warning threshold inline and gates save', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    const warn = await screen.findByTestId('budget-org-warn')
    fireEvent.change(warn, { target: { value: '80.5' } })

    // Inline error + aria + a disabled save (no round-trip on a bad value).
    expect(screen.getByText(/Warning threshold must be a whole number/i)).toBeInTheDocument()
    expect(warn).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('budget-org-save')).toBeDisabled()
    expect(api).not.toHaveBeenCalledWith('/org/config', expect.objectContaining({ method: 'POST' }))

    // A whole number clears it and re-enables save.
    fireEvent.change(warn, { target: { value: '80' } })
    expect(screen.queryByText(/Warning threshold must be a whole number/i)).not.toBeInTheDocument()
    expect(warn).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByTestId('budget-org-save')).toBeEnabled()
  })

  it('refetches after a partial org save so Off can still turn off the limit that landed', async () => {
    mockBudgetApi({ monthlyUsd: 0 })
    const healthy = vi.mocked(api).getMockImplementation()!
    let held = 0
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/org/config' && init?.method === 'POST') {
        const { key, value } = JSON.parse(String(init.body))
        if (key === 'ai.budgetWarnPercent') throw new Error('warn write failed')
        if (key === 'ai.budgetMonthlyUsd') held = value
        return {}
      }
      if (path === '/org/config') {
        return { config: [{ key: 'ai.budgetMonthlyUsd', value: held }, { key: 'ai.budgetWarnPercent', value: 75 }, { key: 'ai.budgetExceededPolicy', value: 'warn' }] }
      }
      return healthy(path, init)
    })
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-org-off')
    fireEvent.click(screen.getByTestId('budget-org-mode-limit'))
    fireEvent.change(screen.getByTestId('budget-org-monthly'), { target: { value: '50' } })
    fireEvent.click(screen.getByTestId('budget-org-save'))

    expect(await screen.findByRole('alert')).toHaveTextContent('warn write failed')
    await waitFor(() => expect(screen.getByTestId('budget-org-monthly')).toBeEnabled())
    expect(held).toBe(50)
    // The refetch must not clear the failure it follows, or drop what was typed.
    expect(screen.getByRole('alert')).toHaveTextContent('warn write failed')
    expect(screen.getByTestId('budget-org-monthly')).toHaveValue(50)

    fireEvent.click(screen.getByTestId('budget-org-mode-off'))
    expect(screen.queryByTestId('budget-org-off')).not.toBeInTheDocument()
    expect(screen.getByTestId('budget-org-save')).toBeEnabled()
    fireEvent.click(screen.getByTestId('budget-org-save'))
    await waitFor(() => expect(held).toBe(0))
  })

  it('lets a changed limit be reverted after a partial org save', async () => {
    mockBudgetApi()
    const healthy = vi.mocked(api).getMockImplementation()!
    let held = 25.5
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/org/config' && init?.method === 'POST') {
        const { key, value } = JSON.parse(String(init.body))
        if (key === 'ai.budgetExceededPolicy') throw new Error('policy write failed')
        if (key === 'ai.budgetMonthlyUsd') held = value
        return {}
      }
      if (path === '/org/config') {
        return { config: [{ key: 'ai.budgetMonthlyUsd', value: held }, { key: 'ai.budgetWarnPercent', value: 75 }, { key: 'ai.budgetExceededPolicy', value: 'block' }] }
      }
      return healthy(path, init)
    })
    render(<BudgetSettingsPanel />)

    const monthly = await screen.findByTestId('budget-org-monthly')
    fireEvent.change(monthly, { target: { value: '40' } })
    fireEvent.click(screen.getByTestId('budget-org-save'))
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.getByTestId('budget-org-monthly')).toBeEnabled())

    fireEvent.change(screen.getByTestId('budget-org-monthly'), { target: { value: '25.5' } })
    expect(screen.getByTestId('budget-org-save')).toBeEnabled()
  })

  it('locks the org form while a failed save leaves the server state unknown', async () => {
    mockBudgetApi()
    const healthy = vi.mocked(api).getMockImplementation()!
    let saveFailed = false
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/org/config' && init?.method === 'POST') {
        saveFailed = true
        throw new Error('save failed')
      }
      if (path === '/org/config' && saveFailed) throw new Error('read failed')
      return healthy(path, init)
    })
    render(<BudgetSettingsPanel />)

    fireEvent.change(await screen.findByTestId('budget-org-monthly'), { target: { value: '40' } })
    fireEvent.click(screen.getByTestId('budget-org-save'))

    expect(await screen.findByRole('alert')).toHaveTextContent('save failed')
    await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path, init]) => path === '/org/config' && !init).length).toBeGreaterThan(1))
    expect(screen.getByTestId('budget-org-save')).toBeDisabled()
    expect(screen.getByTestId('budget-org-monthly')).toBeDisabled()
  })

  it('rejects a warning threshold of 0, which the server would read as 80', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    const warn = await screen.findByTestId('budget-org-warn')
    expect(warn).toHaveAttribute('min', '1')
    fireEvent.change(warn, { target: { value: '0' } })
    expect(screen.getByText('Warning threshold must be a whole number between 1 and 100')).toBeInTheDocument()
    expect(warn).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('budget-org-save')).toBeDisabled()

    fireEvent.change(warn, { target: { value: '1' } })
    expect(screen.getByTestId('budget-org-save')).toBeEnabled()
  })

  it('says workflow limits still apply when the org budget is Off', async () => {
    mockBudgetApi({ monthlyUsd: 0 })
    render(<BudgetSettingsPanel />)

    const off = await screen.findByTestId('budget-org-off')
    expect(off).toHaveTextContent('Workflow limits still apply')
    expect(off).not.toHaveTextContent('not checked')
  })

  it('says when no workflow matches the filter', async () => {
    const workflows = Array.from({ length: 12 }, (_, index) => ({ id: `wf_${index + 10}`, orgId: 'default', name: `Flow ${index + 10}` }))
    mockBudgetApi({ workflows })
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-row-wf_19')
    fireEvent.change(screen.getByTestId('budget-workflow-filter'), { target: { value: 'nothing' } })

    expect(screen.getByTestId('budget-workflow-no-match')).toHaveTextContent('No workflows match this filter')
    expect(screen.queryByTestId('budget-workflow-table')).not.toBeInTheDocument()
  })

  it('does not imply a workflow is missing when the list may be truncated', async () => {
    const workflows = Array.from({ length: 100 }, (_, index) => ({ id: `wf_${index + 10}`, orgId: 'default', name: `Flow ${index + 10}` }))
    mockBudgetApi({ workflows })
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-row-wf_19')
    fireEvent.change(screen.getByTestId('budget-workflow-filter'), { target: { value: 'nothing' } })

    expect(screen.getByTestId('budget-workflow-no-match')).toHaveTextContent('No match in the first 100 workflows')
  })

  it('leaves another row\'s open editor and focus alone when a save finishes', async () => {
    mockBudgetApi()
    const healthy = vi.mocked(api).getMockImplementation()!
    let finishSave: (value: unknown) => void = () => {}
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/workflows/wf_1/budget') return new Promise((resolve) => { finishSave = resolve })
      return healthy(path, init)
    })
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    await waitFor(() => expect(screen.getByTestId('budget-workflow-edit-wf_2')).toBeEnabled())
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    fireEvent.change(screen.getByTestId('budget-workflow-monthly'), { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('budget-workflow-save'))
    await waitFor(() => expect(postsTo('/workflows/wf_1/budget')).toHaveLength(1))

    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_2'))
    expect(screen.getByTestId('budget-workflow-edit-wf_2')).toHaveAttribute('aria-expanded', 'true')
    const mode = screen.getByTestId('budget-workflow-mode-limit')
    mode.focus()

    finishSave({})
    await waitFor(() => expect(useWorkflowStore.getState().toasts).toHaveLength(1))
    expect(screen.getByTestId('budget-workflow-edit-wf_2')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('budget-workflow-mode-limit')).toHaveFocus()
  })

  it('keeps an open editor and its draft when the filter stops matching its row', async () => {
    const workflows = Array.from({ length: 12 }, (_, index) => ({ id: `wf_${index + 10}`, orgId: 'default', name: `Flow ${index + 10}` }))
    mockBudgetApi({ workflows })
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-row-wf_10')
    await waitFor(() => expect(screen.getByTestId('budget-workflow-edit-wf_10')).toBeEnabled())
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_10'))
    fireEvent.click(screen.getByTestId('budget-workflow-mode-limit'))
    fireEvent.change(screen.getByTestId('budget-workflow-monthly'), { target: { value: '9' } })

    fireEvent.change(screen.getByTestId('budget-workflow-filter'), { target: { value: 'flow 21' } })
    expect(screen.getByTestId('budget-workflow-monthly')).toHaveValue(9)
    expect(screen.getByTestId('budget-workflow-row-wf_21')).toBeInTheDocument()
    expect(screen.queryByTestId('budget-workflow-row-wf_11')).not.toBeInTheDocument()
  })

  it('keeps an open editor past the page limit when the filter is cleared', async () => {
    const workflows = Array.from({ length: 12 }, (_, index) => ({ id: `wf_${index + 10}`, orgId: 'default', name: `Flow ${index + 10}` }))
    mockBudgetApi({ workflows })
    render(<BudgetSettingsPanel />)

    fireEvent.change(await screen.findByTestId('budget-workflow-filter'), { target: { value: 'flow 21' } })
    await waitFor(() => expect(screen.getByTestId('budget-workflow-edit-wf_21')).toBeEnabled())
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_21'))
    fireEvent.click(screen.getByTestId('budget-workflow-mode-limit'))
    fireEvent.change(screen.getByTestId('budget-workflow-monthly'), { target: { value: '9' } })

    fireEvent.change(screen.getByTestId('budget-workflow-filter'), { target: { value: '' } })
    expect(screen.getByTestId('budget-workflow-monthly')).toHaveValue(9)
    expect(screen.queryByTestId('budget-workflow-row-wf_20')).not.toBeInTheDocument()
  })

  it('keeps an open editor and flags the row when its refresh fails', async () => {
    mockBudgetApi()
    const healthy = vi.mocked(api).getMockImplementation()!
    let readFails = false
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (readFails && path.includes('workflowId=wf_1')) throw new Error('boom')
      return healthy(path, init)
    })
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    fireEvent.change(screen.getByTestId('budget-workflow-monthly'), { target: { value: '9' } })

    readFails = true
    useWorkflowStore.getState().bumpPlatformVersion(REFRESH_TAGS)

    await waitFor(() => expect(screen.getByTestId('budget-workflow-limit-wf_1')).toHaveTextContent('Failed to load budget'))
    expect(screen.queryByTestId('budget-workflow-meter-wf_1')).not.toBeInTheDocument()
    expect(screen.getByTestId('budget-workflow-monthly')).toHaveValue(9)

    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    expect(screen.getByTestId('budget-workflow-edit-wf_1')).toBeDisabled()
  })

  it('drops the org meter when its refresh fails instead of showing stale spend', async () => {
    mockBudgetApi()
    const healthy = vi.mocked(api).getMockImplementation()!
    let readFails = false
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (readFails && path === '/billing/budget') throw new Error('boom')
      return healthy(path, init)
    })
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-org-meter')
    readFails = true
    useWorkflowStore.getState().bumpPlatformVersion(REFRESH_TAGS)

    await screen.findByTestId('budget-org-spend-unavailable')
    expect(screen.queryByTestId('budget-org-meter')).not.toBeInTheDocument()
  })

  it('rejects a limit below a cent, which float4 storage could turn into Org-wide', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    const monthly = screen.getByTestId('budget-workflow-monthly')
    expect(monthly).toHaveAttribute('min', '0.01')
    for (const tiny of ['0.001', '1e-50']) {
      fireEvent.change(monthly, { target: { value: tiny } })
      expect(monthly).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByTestId('budget-workflow-save')).toBeDisabled()
    }
    fireEvent.change(monthly, { target: { value: '0.01' } })
    expect(screen.getByTestId('budget-workflow-save')).toBeEnabled()
  })

  it('rejects a limit too large for float4 storage', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    const monthly = await screen.findByTestId('budget-org-monthly')
    fireEvent.change(monthly, { target: { value: '1e39' } })
    expect(monthly).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('budget-org-save')).toBeDisabled()
  })

  it('does not rewrite a stored limit the user did not edit', async () => {
    mockBudgetApi()
    const healthy = vi.mocked(api).getMockImplementation()!
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      // float4 reads 123456.78 back as 123456.78125.
      if (path.includes('workflowId=wf_1')) return { ...WORKFLOW_ENVELOPE, monthlyUsdLimit: 123456.78125 }
      return healthy(path, init)
    })
    render(<BudgetSettingsPanel />)

    await screen.findByTestId('budget-workflow-meter-wf_1')
    expect(screen.getByTestId('budget-workflow-limit-wf_1')).toHaveTextContent('$123456.78 / month')
    fireEvent.click(screen.getByTestId('budget-workflow-edit-wf_1'))
    expect(screen.getByTestId('budget-workflow-monthly')).toHaveValue(123456.78)
    fireEvent.change(screen.getByTestId('budget-workflow-warn'), { target: { value: '71' } })
    fireEvent.click(screen.getByTestId('budget-workflow-save'))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/workflows/wf_1/budget', expect.objectContaining({
        body: JSON.stringify({ monthlyUsd: 123456.78, warnPercent: 71, policy: 'block' }),
      }))
    })
  })

  it('flags a negative monthly budget inline and gates save', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    const monthly = await screen.findByTestId('budget-org-monthly')
    fireEvent.change(monthly, { target: { value: '-5' } })
    expect(screen.getByText('Monthly limit must be at least $0.01')).toBeInTheDocument()
    expect(monthly).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('budget-org-save')).toBeDisabled()
  })
})
