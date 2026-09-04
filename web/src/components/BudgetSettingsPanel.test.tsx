import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
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

const initialState = useWorkflowStore.getState()

function mockBudgetApi() {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/org/config' && init?.method === 'POST') {
      return JSON.parse(String(init.body))
    }
    if (path === '/org/config') {
      return {
        config: [
          { key: 'ai.budgetMonthlyUsd', value: 25.5, source: 'db' },
          { key: 'ai.budgetWarnPercent', value: 75, source: 'db' },
          { key: 'ai.budgetExceededPolicy', value: 'block', source: 'db' },
        ],
      }
    }
    if (path === '/workflows') return [{ id: 'wf_1', name: 'Refund triage' }]
    if (path.startsWith('/billing/budget?workflowId=wf_1')) {
      return {
        allowed: true,
        monthlyUsdSpent: 4,
        monthlyUsdLimit: 7.5,
        policy: 'block',
        warningPercent: 70,
        warningThresholdCrossed: false,
        exceededAt: null,
        resolvedScope: 'workflow',
      }
    }
    if (path === '/workflows/wf_1/budget' && init?.method === 'POST') {
      return { id: 'budget_1', workflowId: 'wf_1', monthlyUsd: 8, warnPercent: 70, policy: 'block' }
    }
    return []
  })
}

describe('<BudgetSettingsPanel />', () => {
  beforeEach(() => {
    // Cancel any pending bumpPlatformVersion timer left by a prior
    // test so the 100ms debounce can't bleed across cases.
    __resetBumpCoalesceForTests()
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [], budgetBlocked: null }, true)
  })

  it('loads org budget values from the /org/config envelope', async () => {
    mockBudgetApi()

    render(<BudgetSettingsPanel />)

    await waitFor(() => {
      expect(screen.getByTestId('budget-org-monthly')).toHaveValue(25.5)
    })
    expect(screen.getByTestId('budget-org-warn')).toHaveValue(75)
    expect(screen.getByTestId('budget-org-policy')).toHaveValue('block')
  })

  it('loads an existing workflow override into all workflow fields', async () => {
    mockBudgetApi()

    render(<BudgetSettingsPanel />)

    fireEvent.change(await screen.findByTestId('budget-workflow-select'), { target: { value: 'wf_1' } })

    await waitFor(() => {
      expect(screen.getByTestId('budget-workflow-monthly')).toHaveValue(7.5)
    })
    expect(screen.getByTestId('budget-workflow-warn')).toHaveValue(70)
    expect(screen.getByTestId('budget-workflow-policy')).toHaveValue('block')
  })

  it('renders the workflow policy options with the descriptive labels, matching the org selector', async () => {
    mockBudgetApi()

    render(<BudgetSettingsPanel />)

    // The workflow-level policy dropdown must show the same descriptive labels
    // as the org-level selector — not the bare "warn" / "block" key names.
    const wfPolicy = await screen.findByTestId('budget-workflow-policy')
    expect(wfPolicy).toHaveTextContent('keep AI calls running')
    expect(wfPolicy).toHaveTextContent('Block new calls at the recorded threshold')
  })

  it('saves org budget fields through the existing org config route and bumps platformVersion', async () => {
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
    // bumpPlatformVersion is debounced (100ms trailing edge) — assert
    // via waitFor so the timer fires under real wallclock during the
    // poll window.
    await waitFor(() => expect(useWorkflowStore.getState().platformVersion).toBe(1))
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

  it('flags a negative monthly budget inline and gates save', async () => {
    mockBudgetApi()
    render(<BudgetSettingsPanel />)

    const monthly = await screen.findByTestId('budget-org-monthly')
    fireEvent.change(monthly, { target: { value: '-5' } })
    expect(screen.getByText(/non-negative/i)).toBeInTheDocument()
    expect(monthly).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('budget-org-save')).toBeDisabled()
  })
})
