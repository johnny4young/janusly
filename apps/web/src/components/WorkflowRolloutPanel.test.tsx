import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import { ConfirmProvider } from './ConfirmDialog'
import { WorkflowRolloutPanel } from './WorkflowRolloutPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const initialState = useWorkflowStore.getState()
const versions = [
  { id: 'version-2', version: 2, dagJson: { nodes: [], edges: [] } },
  { id: 'version-1', version: 1, dagJson: { nodes: [], edges: [] } },
]

function activeRollout(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rollout-1',
    workflowId: 'workflow-1',
    baselineVersionId: 'version-1',
    canaryVersionId: 'version-2',
    trafficPercent: 20,
    minimumSampleSize: 5,
    minimumSuccessRatePercent: 90,
    status: 'active',
    baselineSucceeded: 8,
    baselineFailed: 1,
    canarySucceeded: 4,
    canaryFailed: 1,
    rolledBackReason: null,
    createdAt: '2026-07-21T12:00:00.000Z',
    updatedAt: '2026-07-21T12:05:00.000Z',
    endedAt: null,
    lastOutcomeAt: '2026-07-21T12:05:00.000Z',
    ...overrides,
  }
}

describe('<WorkflowRolloutPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({
      ...initialState,
      currentWorkflowId: 'workflow-1',
      currentWorkflowSaved: true,
      platformVersion: 0,
      toasts: [],
    }, true)
  })

  it('does not fetch deployment state for an unsaved draft', () => {
    useWorkflowStore.setState({ currentWorkflowSaved: false }, false)

    const { container } = render(<WorkflowRolloutPanel />)

    expect(container).toBeEmptyDOMElement()
    expect(api).not.toHaveBeenCalled()
  })

  it('starts a bounded rollout from the previous version to latest', async () => {
    let rollout: ReturnType<typeof activeRollout> | null = null
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (path.startsWith('/workflows/versions')) return versions
      if (path === '/workflows/workflow-1/rollout' && options?.method === 'POST') {
        rollout = activeRollout()
        return { rollout }
      }
      if (path === '/workflows/workflow-1/rollout') return { rollout }
      throw new Error(`Unexpected API call: ${path}`)
    })

    render(<WorkflowRolloutPanel />)

    expect(await screen.findByText('Canary version')).toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Canary traffic (%)'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Minimum outcomes'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start canary' }))

    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true))
    const createOptions = vi.mocked(api).mock.calls.find(([, options]) => options?.method === 'POST')?.[1]
    expect(JSON.parse(String(createOptions?.body))).toEqual({
      baselineVersionId: 'version-1',
      canaryVersionId: 'version-2',
      trafficPercent: 20,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 90,
    })
    expect(await screen.findByText('20% to canary · v2')).toBeInTheDocument()
  })

  it('renders measured outcomes and guardrail for an active rollout', async () => {
    vi.mocked(api).mockImplementation(async path => {
      if (path.startsWith('/workflows/versions')) return versions
      return { rollout: activeRollout() }
    })

    render(<WorkflowRolloutPanel />)

    expect(await screen.findByTestId('workflow-rollout-status')).toBeInTheDocument()
    expect(screen.getByText('80.0%')).toBeInTheDocument()
    expect(screen.getByText('≥ 90% / 5')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveValue(20)
  })

  it('returns traffic to baseline only after the accessible confirmation', async () => {
    let rollout = activeRollout()
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (path.startsWith('/workflows/versions')) return versions
      if (path.endsWith('/rollback') && options?.method === 'POST') {
        rollout = activeRollout({ status: 'rolled_back', endedAt: '2026-07-21T12:10:00.000Z' })
      }
      return { rollout }
    })

    render(<ConfirmProvider><WorkflowRolloutPanel /></ConfirmProvider>)

    fireEvent.click(await screen.findByRole('button', { name: 'Return to baseline' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('In-flight runs are not interrupted.')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Return to baseline' }))

    expect(await screen.findByText('Rolled back')).toBeInTheDocument()
    expect(screen.getByText('New production traffic is using the baseline version.')).toBeInTheDocument()
  })

  it('drops malformed API rows instead of rendering unsafe counters', async () => {
    vi.mocked(api).mockImplementation(async path => {
      if (path.startsWith('/workflows/versions')) return versions
      return { rollout: { ...activeRollout(), canaryFailed: -1 } }
    })

    render(<WorkflowRolloutPanel />)

    expect(await screen.findByRole('button', { name: 'Start canary' })).toBeInTheDocument()
    expect(screen.queryByTestId('workflow-rollout-status')).not.toBeInTheDocument()
  })
})
