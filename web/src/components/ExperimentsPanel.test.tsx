import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { changeAppLanguage } from '../i18n'
import { useWorkflowStore } from '../store'
import { ExperimentsPanel } from './ExperimentsPanel'
import { useInvalidationNonce } from '../lib/query-cache'

vi.mock('../api', () => ({ api: vi.fn() }))

const EXPERIMENT_TAGS = ['experiments'] as const

const summary = {
  scorerKind: 'string_equality',
  exampleCount: 4,
  control: { meanScore: 0.5, totalCostUsd: 0.01, costKnownCount: 4, meanLatencyMs: 120, errorCount: 1, judgedByLlmCount: 0, scoringFallbackCount: 0 },
  candidate: { meanScore: 0.8, totalCostUsd: 0.02, costKnownCount: 4, meanLatencyMs: 90, errorCount: 0, judgedByLlmCount: 0, scoringFallbackCount: 0 },
  scoreDelta: 0.3,
  costDelta: 0.01,
  recommendation: 'promote_candidate',
  recommendationReasonCode: 'candidate_score_improved',
  recommendationReason: 'Candidate scored 30.0 points higher on average.',
} as const

const experiment = {
  id: 'exp-1',
  name: 'Triage candidate',
  kind: 'prompt',
  controlRef: 'triage@1',
  candidateRef: 'triage@2',
  evalDatasetId: 'dataset-1',
  scorerKind: 'string_equality',
  status: 'completed',
  summary,
  createdAt: '2026-07-10T12:00:00.000Z',
  completedAt: '2026-07-10T12:01:00.000Z',
}

beforeEach(() => {
  changeAppLanguage('en')
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ toasts: [], identityContext: null })
})

describe('<ExperimentsPanel />', () => {
  it('loads a selected experiment and renders aggregate control/candidate metrics', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/experiments') return { experiments: [experiment] }
      if (path === '/eval/datasets') return { datasets: [{ id: 'dataset-1', name: 'Accepted recoveries', description: '', exampleCount: 4 }] }
      if (path === '/experiments/exp-1') return { experiment }
      return {}
    })

    render(<ExperimentsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Triage candidate/i }))

    await waitFor(() => expect(screen.getByTestId('experiment-detail')).toBeInTheDocument())
    expect(screen.getByRole('columnheader', { name: 'Score' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Scoring fallbacks' })).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'Control' })).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'Candidate' })).toBeInTheDocument()
    expect(screen.getByText('Candidate recommended')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy candidate reference' })).toBeInTheDocument()
  })

  it('posts a complete comparison request and immediately renders its returned summary', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/experiments') return { experiments: [] }
      if (path === '/eval/datasets') return { datasets: [{ id: 'dataset-1', name: 'Accepted recoveries', description: '', exampleCount: 4 }] }
      if (path === '/experiments/run') return { experiment, summary }
      return {}
    })

    render(<ExperimentsPanel />)

    await screen.findByRole('option', { name: 'Accepted recoveries · 4 examples' })
    fireEvent.click(screen.getByTestId('experiment-step-next'))
    fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'triage@1' } })
    fireEvent.change(screen.getByLabelText('Candidate reference'), { target: { value: 'triage@2' } })
    fireEvent.click(screen.getByTestId('experiment-step-next'))
    fireEvent.change(screen.getByLabelText('Experiment name'), { target: { value: 'Triage candidate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run comparison' }))

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalledWith('/experiments/run', expect.objectContaining({ method: 'POST' }))
    })
    const call = vi.mocked(api).mock.calls.find(([path]) => path === '/experiments/run')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: 'Triage candidate',
      kind: 'prompt',
      controlRef: 'triage@1',
      candidateRef: 'triage@2',
      evalDatasetId: 'dataset-1',
      scorerKind: 'string_equality',
    })
    expect(await screen.findByText('Candidate recommended')).toBeInTheDocument()
  })

  it('selects the complete list projection without a redundant detail request', async () => {
    const second = { ...experiment, id: 'exp-2', name: 'Second candidate' }

    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/experiments') return { experiments: [experiment, second] }
      if (path === '/eval/datasets') return { datasets: [] }
      return {}
    })

    render(<ExperimentsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Triage candidate/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Second candidate/i }))
    expect(screen.getByRole('heading', { name: 'Second candidate' })).toBeInTheDocument()
    expect(vi.mocked(api)).not.toHaveBeenCalledWith(expect.stringMatching(/^\/experiments\//))
  })

  it('creates a dataset locally, selects it for the next comparison, and signals the shared refresh', async () => {
    const { result: refresh } = renderHook(() => useInvalidationNonce(EXPERIMENT_TAGS))
    const dataset = { id: 'dataset-new', name: 'June recoveries', description: 'Accepted samples', exampleCount: 8 }
    const datasets: typeof dataset[] = []
    vi.mocked(api).mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/experiments') return { experiments: [] }
      if (path === '/eval/datasets' && options?.method === 'POST') {
        datasets.push(dataset)
        return { dataset }
      }
      if (path === '/eval/datasets') return { datasets }
      return {}
    })

    render(<ExperimentsPanel />)

    await screen.findByText('No experiments yet')
    fireEvent.change(screen.getByLabelText('Dataset name'), { target: { value: 'June recoveries' } })
    fireEvent.change(screen.getByLabelText('Automatic expiry'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create dataset' }))

    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith('/eval/datasets', expect.objectContaining({ method: 'POST' })))
    const call = vi.mocked(api).mock.calls.find(([path, options]) => path === '/eval/datasets' && options?.method === 'POST')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: 'June recoveries', retentionDays: 90 })
    await waitFor(() => expect(refresh.current).toBe(1))
    expect(screen.getByRole('option', { name: 'June recoveries · 8 examples' })).toBeInTheDocument()
  })

  it('derives the recommendation text from metrics in the active locale', async () => {
    changeAppLanguage('es')
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/experiments') return { experiments: [experiment] }
      if (path === '/eval/datasets') return { datasets: [] }
      if (path === '/experiments/exp-1') return { experiment }
      return {}
    })

    render(<ExperimentsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Triage candidate/i }))

    expect(await screen.findByText('El candidato obtuvo 30,0 puntos más en promedio.')).toBeInTheDocument()
  })

  it('renders a valid aggregate summary when its legacy display reason is absent', async () => {
    const experimentWithoutReason = {
      ...experiment,
      summary: { ...summary, recommendationReason: undefined, recommendationReasonCode: undefined },
    }
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/experiments') return { experiments: [experimentWithoutReason] }
      if (path === '/eval/datasets') return { datasets: [] }
      if (path === '/experiments/exp-1') return { experiment: experimentWithoutReason }
      return {}
    })

    render(<ExperimentsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Triage candidate/i }))

    expect(await screen.findByText('Candidate scored 30.0 points higher on average.')).toBeInTheDocument()
  })

  it('explains an inconclusive LLM-judge fallback instead of claiming the dataset is empty', async () => {
    const fallbackExperiment = {
      ...experiment,
      summary: {
        ...summary,
        scorerKind: 'llm_judge',
        recommendation: 'inconclusive',
        recommendationReasonCode: 'scoring_fallback',
        control: { ...summary.control, judgedByLlmCount: 4 },
        candidate: { ...summary.candidate, judgedByLlmCount: 3, scoringFallbackCount: 1 },
      },
    }
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/experiments') return { experiments: [fallbackExperiment] }
      if (path === '/eval/datasets') return { datasets: [] }
      if (path === '/experiments/exp-1') return { experiment: fallbackExperiment }
      return {}
    })

    render(<ExperimentsPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /Triage candidate/i }))

    expect(await screen.findByText(/deterministic fallback scoring was used/i)).toBeInTheDocument()
    expect(screen.queryByText(/has no examples/i)).not.toBeInTheDocument()
  })

  it('shows the provider-call plan and blocks an oversized LLM-judge run', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/experiments') return { experiments: [], limits: { maxProviderCalls: 20 } }
      if (path === '/eval/datasets') return { datasets: [{ id: 'dataset-1', name: 'Six cases', description: '', exampleCount: 6 }] }
      return {}
    })

    render(<ExperimentsPanel />)

    await screen.findByRole('option', { name: 'Six cases · 6 examples' })
    fireEvent.click(screen.getByTestId('experiment-step-arms'))
    fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'model-a' } })
    fireEvent.change(screen.getByLabelText('Candidate reference'), { target: { value: 'model-b' } })
    fireEvent.click(screen.getByTestId('experiment-step-run'))
    fireEvent.change(screen.getByLabelText('Experiment name'), { target: { value: 'Judge candidate' } })
    fireEvent.change(screen.getByLabelText('Scorer'), { target: { value: 'llm_judge' } })

    expect(screen.getByRole('alert')).toHaveTextContent('This plan needs 24 provider calls')
    expect(screen.getByRole('button', { name: 'Run comparison' })).toBeDisabled()
    expect(screen.queryByLabelText('Judge model override')).not.toBeInTheDocument()
  })

  it('surfaces initial API failures instead of presenting them as empty data', async () => {
    vi.mocked(api).mockRejectedValue(new Error('network unavailable'))

    render(<ExperimentsPanel />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/network unavailable/i)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  describe('three-step setup', () => {
    const blocker = () => screen.getByTestId('experiment-run-blocker')
    const runButton = () => screen.getByTestId('experiment-run')
    function mockData(datasets: unknown[], limits?: unknown): void {
      vi.mocked(api).mockImplementation(async (path: string) => {
        if (path === '/experiments') return { experiments: [], limits }
        if (path === '/eval/datasets') return { datasets }
        return {}
      })
    }
    const dataset = (exampleCount: number) => ({ id: 'dataset-1', name: 'Bed', description: '', exampleCount })

    it('names the missing dataset step and offers only creation when none exists', async () => {
      mockData([])
      render(<ExperimentsPanel />)

      await waitFor(() => expect(blocker()).toHaveTextContent('Step 1 · Dataset: create a dataset first'))
      expect(runButton()).toBeDisabled()
      expect(runButton()).toHaveAttribute('aria-describedby', 'experiment-run-blocker')
      expect(screen.getByTestId('experiment-step-dataset')).toHaveAttribute('aria-current', 'step')
      expect(screen.queryByLabelText('Evaluation dataset')).not.toBeInTheDocument()
      expect(screen.getByTestId('experiment-create-dataset')).toBeInTheDocument()
      expect(screen.getByTestId('experiment-dataset-create')).toBeDisabled()
      expect(screen.getByTestId('experiment-panel-dataset')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('experiment-step-run'))
      fireEvent.click(blocker())
      expect(screen.getByTestId('experiment-step-dataset')).toHaveAttribute('aria-current', 'step')
      expect(screen.getByLabelText('Dataset name')).toHaveFocus()
    })

    it('points loading and failed lists at the dataset list and Retry, never at creation', async () => {
      let rejectDatasets: (error: Error) => void = () => undefined
      let calls = 0
      vi.mocked(api).mockImplementation((path: string) => {
        if (path !== '/eval/datasets') return Promise.resolve({ experiments: [] })
        calls += 1
        return calls === 1
          ? new Promise((_, reject) => { rejectDatasets = reject })
          : Promise.resolve({ datasets: [dataset(4)] })
      })
      render(<ExperimentsPanel />)

      expect(blocker()).toHaveTextContent('Step 1 · Dataset: loading datasets')
      expect(screen.getByLabelText('Evaluation dataset')).toBeInTheDocument()
      fireEvent.click(blocker())
      await waitFor(() => expect(screen.getByLabelText('Evaluation dataset')).toHaveFocus())

      rejectDatasets(new Error('offline'))
      await waitFor(() => expect(blocker()).toHaveTextContent('Step 1 · Dataset: datasets could not be loaded'))
      fireEvent.click(blocker())
      await waitFor(() => expect(screen.getByTestId('experiment-datasets-retry')).toHaveFocus())
      expect(screen.getByLabelText('Dataset name')).not.toHaveFocus()

      fireEvent.click(screen.getByTestId('experiment-datasets-retry'))
      await screen.findByRole('option', { name: 'Bed · 4 examples' })
      expect(screen.queryByTestId('experiment-datasets-retry')).not.toBeInTheDocument()
    })

    it('blocks text the server would reject, counting UTF-8 bytes', async () => {
      mockData([dataset(4)])
      render(<ExperimentsPanel />)
      await screen.findByRole('option', { name: 'Bed · 4 examples' })

      fireEvent.click(screen.getByTestId('experiment-step-arms'))
      fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'a'.repeat(257) } })
      fireEvent.change(screen.getByLabelText('Candidate reference'), { target: { value: 'b'.repeat(256) } })
      expect(blocker()).toHaveTextContent('Step 2 · Control vs candidate: shorten the reference')
      expect(screen.getByLabelText('Control reference')).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByTestId('experiment-control-limit')).toHaveTextContent('257 of 256 bytes')
      expect(screen.queryByTestId('experiment-candidate-limit')).not.toBeInTheDocument()
      fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'a'.repeat(256) } })

      fireEvent.click(screen.getByTestId('experiment-step-run'))
      // 60 accented letters are 60 characters but 120 bytes; one more letter crosses the limit.
      fireEvent.change(screen.getByLabelText('Experiment name'), { target: { value: 'é'.repeat(60) } })
      expect(screen.queryByTestId('experiment-run-blocker')).not.toBeInTheDocument()
      fireEvent.change(screen.getByLabelText('Experiment name'), { target: { value: 'é'.repeat(60) + 'a' } })
      expect(blocker()).toHaveTextContent('Step 3 · Scorer and run: shorten the name')
      expect(screen.getByTestId('experiment-name-limit')).toHaveTextContent('121 of 120 bytes')
      expect(runButton()).toBeDisabled()
    })

    it('keeps an over-limit dataset from being sent and explains a rejected one truthfully', async () => {
      vi.mocked(api).mockImplementation(async (path: string, options?: RequestInit) => {
        if (path === '/experiments') return { experiments: [] }
        if (path === '/eval/datasets' && options?.method === 'POST') throw Object.assign(new Error('Invalid eval dataset body'), { code: 'eval_dataset_name_required' })
        return { datasets: [] }
      })
      render(<ExperimentsPanel />)
      await waitFor(() => expect(blocker()).toHaveTextContent('create a dataset first'))

      fireEvent.change(screen.getByLabelText('Dataset name'), { target: { value: 'ñ'.repeat(61) } })
      expect(screen.getByTestId('experiment-dataset-name-limit')).toHaveTextContent('122 of 120 bytes')
      expect(screen.getByTestId('experiment-dataset-create')).toBeDisabled()
      fireEvent.change(screen.getByLabelText('Dataset name'), { target: { value: 'Reseñas' } })
      fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'x'.repeat(2001) } })
      expect(screen.getByTestId('experiment-dataset-description-limit')).toHaveTextContent('2001 of 2000 bytes')
      expect(screen.getByTestId('experiment-dataset-create')).toBeDisabled()
      fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: '' } })

      fireEvent.click(screen.getByTestId('experiment-dataset-create'))
      await waitFor(() => expect(useWorkflowStore.getState().toasts.at(-1)?.message)
        .toBe('Check the dataset: a name up to 120 bytes and a description up to 2000 bytes'))
    })

    it('reloads datasets when the chosen one was deleted before the run', async () => {
      let listed = [dataset(4)]
      vi.mocked(api).mockImplementation(async (path: string) => {
        if (path === '/experiments') return { experiments: [] }
        if (path === '/eval/datasets') return { datasets: listed }
        if (path === '/experiments/run') {
          listed = []
          throw Object.assign(new Error('Eval dataset not found'), { code: 'eval_dataset_not_found' })
        }
        return {}
      })
      render(<ExperimentsPanel />)
      await screen.findByRole('option', { name: 'Bed · 4 examples' })
      fireEvent.click(screen.getByTestId('experiment-step-arms'))
      fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'a' } })
      fireEvent.change(screen.getByLabelText('Candidate reference'), { target: { value: 'b' } })
      fireEvent.click(screen.getByTestId('experiment-step-run'))
      fireEvent.change(screen.getByLabelText('Experiment name'), { target: { value: 'Run' } })
      fireEvent.click(runButton())

      await waitFor(() => expect(blocker()).toHaveTextContent('Step 1 · Dataset: create a dataset first'))
      expect(runButton()).toBeDisabled()
    })

    it('needs admin rank as well as evals.write, as the server does', async () => {
      const organization = (role: string, roleBase: 'editor' | 'admin') => ({
        id: `org-${role}`, name: role, plan: null, role, roleBase, permissions: ['evals.read', 'evals.write'],
        usable: true, developmentFallback: false, isOwner: false,
      })
      const identity = (org: ReturnType<typeof organization>) => ({
        identity: { userId: 'u', email: null, mode: 'dev-headers' as const, source: 'dev' as const },
        profile: { name: null, email: null }, organizations: [org], invitations: [],
        currentOrganizationId: org.id, selectionRequired: false, needsOrganization: false, truncated: false, invitationsTruncated: false,
      })
      mockData([dataset(4)])
      useWorkflowStore.setState({ identityContext: identity(organization('analyst', 'editor')) })
      const { unmount } = render(<ExperimentsPanel />)
      await screen.findByRole('option', { name: 'Bed · 4 examples' })
      expect(blocker()).toHaveTextContent('Your role can view experiments but not run them.')
      expect(screen.queryByTestId('experiment-create-dataset')).not.toBeInTheDocument()
      unmount()

      useWorkflowStore.setState({ identityContext: identity(organization('lead', 'admin')) })
      render(<ExperimentsPanel />)
      expect(await screen.findByTestId('experiment-create-dataset')).toBeInTheDocument()
    })

    it('starts over when the workspace changes', async () => {
      const org = (id: string) => ({ id, name: id, plan: null, role: 'admin', roleBase: 'admin' as const, permissions: ['evals.read', 'evals.write'], usable: true, developmentFallback: false, isOwner: false })
      const context = (current: string) => ({
        identity: { userId: 'u', email: null, mode: 'dev-headers' as const, source: 'dev' as const },
        profile: { name: null, email: null }, organizations: [org('alpha'), org('beta')], invitations: [],
        currentOrganizationId: current, selectionRequired: false, needsOrganization: false, truncated: false, invitationsTruncated: false,
      })
      vi.mocked(api).mockImplementation(async (path: string) => {
        if (path === '/experiments') return { experiments: [experiment] }
        if (path === '/eval/datasets') return { datasets: [dataset(4)] }
        return {}
      })
      useWorkflowStore.setState({ identityContext: context('alpha') })
      render(<ExperimentsPanel />)
      await screen.findByRole('option', { name: 'Bed · 4 examples' })
      fireEvent.click(screen.getByTestId('experiment-step-arms'))
      fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'alpha-ref' } })
      fireEvent.click(screen.getByRole('button', { name: /Triage candidate/i }))
      expect(screen.getByTestId('experiment-detail')).toBeInTheDocument()

      act(() => useWorkflowStore.setState({ identityContext: context('beta') }))

      expect(screen.getByTestId('experiment-step-dataset')).toHaveAttribute('aria-current', 'step')
      expect(screen.queryByTestId('experiment-detail')).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('experiment-step-arms'))
      expect(screen.getByLabelText('Control reference')).toHaveValue('')
    })

    it('walks each missing field in step order until the run is allowed', async () => {
      mockData([dataset(4)])
      render(<ExperimentsPanel />)
      await screen.findByRole('option', { name: 'Bed · 4 examples' })

      expect(screen.getByTestId('experiment-step-done-dataset')).toBeInTheDocument()
      expect(screen.queryByTestId('experiment-step-done-arms')).not.toBeInTheDocument()
      expect(blocker()).toHaveTextContent('Step 2 · Control vs candidate: enter the control reference')

      fireEvent.click(screen.getByTestId('experiment-step-next'))
      expect(screen.getByLabelText('Comparison kind')).toHaveFocus()
      fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'a@1' } })
      expect(blocker()).toHaveTextContent('Step 2 · Control vs candidate: enter the candidate reference')
      fireEvent.change(screen.getByLabelText('Candidate reference'), { target: { value: '   ' } })
      expect(blocker()).toHaveTextContent('enter the candidate reference')
      fireEvent.change(screen.getByLabelText('Candidate reference'), { target: { value: 'a@2' } })
      expect(screen.getByTestId('experiment-step-done-arms')).toBeInTheDocument()
      expect(blocker()).toHaveTextContent('Step 3 · Scorer and run: name the experiment')

      fireEvent.click(blocker())
      expect(screen.getByLabelText('Experiment name')).toHaveFocus()
      expect(screen.getByTestId('experiment-panel-run')).toBeInTheDocument()
      expect(screen.queryByTestId('experiment-step-next')).not.toBeInTheDocument()
      fireEvent.change(screen.getByLabelText('Experiment name'), { target: { value: 'Run' } })
      expect(screen.queryByTestId('experiment-run-blocker')).not.toBeInTheDocument()
      expect(runButton()).toBeEnabled()
      expect(screen.getByTestId('experiment-step-done-run')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('experiment-step-arms'))
      expect(screen.getByTestId('experiment-panel-arms')).toBeInTheDocument()
      expect(screen.getByLabelText('Control reference')).toHaveValue('a@1')
      expect(runButton()).toBeEnabled()
    })

    it('sends an empty dataset back to step 1 and says why', async () => {
      mockData([dataset(0)])
      render(<ExperimentsPanel />)

      await screen.findByRole('option', { name: 'Bed · 0 examples' })
      expect(blocker()).toHaveTextContent('Step 1 · Dataset: choose a dataset with examples')
      expect(screen.getByRole('alert')).toHaveTextContent('This dataset has no examples')
      expect(runButton()).toHaveAttribute('aria-describedby', 'experiment-call-plan experiment-run-blocker')
    })

    it('names the step that can actually lower the provider calls', async () => {
      mockData([dataset(6)], { maxProviderCalls: 20 })
      const { unmount } = render(<ExperimentsPanel />)
      await screen.findByRole('option', { name: 'Bed · 6 examples' })
      fireEvent.click(screen.getByTestId('experiment-step-arms'))
      fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'a' } })
      fireEvent.change(screen.getByLabelText('Candidate reference'), { target: { value: 'b' } })
      fireEvent.click(screen.getByTestId('experiment-step-run'))
      fireEvent.change(screen.getByLabelText('Scorer'), { target: { value: 'llm_judge' } })
      expect(blocker()).toHaveTextContent('Step 3 · Scorer and run: choose a scorer without LLM calls')
      unmount()

      mockData([dataset(11)], { maxProviderCalls: 20 })
      render(<ExperimentsPanel />)
      await screen.findByRole('option', { name: 'Bed · 11 examples' })
      expect(blocker()).toHaveTextContent('Step 1 · Dataset: choose a smaller dataset')
    })

    it('tells a read-only role why it cannot run and hides dataset creation', async () => {
      mockData([dataset(4)])
      render(<ExperimentsPanel canWrite={false} />)

      await screen.findByRole('option', { name: 'Bed · 4 examples' })
      expect(blocker()).toHaveTextContent('Your role can view experiments but not run them.')
      expect(screen.queryByTestId('experiment-create-dataset')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('experiment-step-arms'))
      fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'a' } })
      fireEvent.change(screen.getByLabelText('Candidate reference'), { target: { value: 'b' } })
      fireEvent.click(screen.getByTestId('experiment-step-run'))
      fireEvent.change(screen.getByLabelText('Experiment name'), { target: { value: 'Run' } })
      expect(runButton()).toBeDisabled()
      expect(runButton()).toHaveAttribute('aria-describedby', 'experiment-call-plan experiment-run-blocker')
    })

    it('renders the missing step in Spanish', async () => {
      changeAppLanguage('es')
      mockData([])
      render(<ExperimentsPanel />)

      await waitFor(() => expect(blocker()).toHaveTextContent('Paso 1 · Conjunto de evaluación: primero crea un conjunto'))
    })
  })
})
