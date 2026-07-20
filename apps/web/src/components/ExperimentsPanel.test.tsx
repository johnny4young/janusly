import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { changeAppLanguage } from '../i18n'
import { useWorkflowStore } from '../store'
import { ExperimentsPanel } from './ExperimentsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const summary = {
  scorerKind: 'string_equality',
  exampleCount: 4,
  control: { meanScore: 0.5, totalCostUsd: 0.01, costKnownCount: 4, meanLatencyMs: 120, errorCount: 1, judgedByLlmCount: 0 },
  candidate: { meanScore: 0.8, totalCostUsd: 0.02, costKnownCount: 4, meanLatencyMs: 90, errorCount: 0, judgedByLlmCount: 0 },
  scoreDelta: 0.3,
  costDelta: 0.01,
  recommendation: 'promote_candidate',
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
  summaryJson: summary,
  createdAt: '2026-07-10T12:00:00.000Z',
  completedAt: '2026-07-10T12:01:00.000Z',
}

beforeEach(() => {
  changeAppLanguage('en')
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ platformVersion: 0, toasts: [] })
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
    fireEvent.change(screen.getByLabelText('Experiment name'), { target: { value: 'Triage candidate' } })
    fireEvent.change(screen.getByLabelText('Control reference'), { target: { value: 'triage@1' } })
    fireEvent.change(screen.getByLabelText('Candidate reference'), { target: { value: 'triage@2' } })
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

  it('keeps the most recently selected experiment when an older detail request resolves late', async () => {
    let resolveFirst!: (value: unknown) => void
    let resolveSecond!: (value: unknown) => void
    const firstDetail = new Promise<unknown>((resolve) => { resolveFirst = resolve })
    const secondDetail = new Promise<unknown>((resolve) => { resolveSecond = resolve })
    const second = { ...experiment, id: 'exp-2', name: 'Second candidate' }

    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/experiments') return { experiments: [experiment, second] }
      if (path === '/eval/datasets') return { datasets: [] }
      if (path === '/experiments/exp-1') return firstDetail
      if (path === '/experiments/exp-2') return secondDetail
      return {}
    })

    render(<ExperimentsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /Triage candidate/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Second candidate/i }))
    resolveSecond({ experiment: second })
    expect(await screen.findByRole('heading', { name: 'Second candidate' })).toBeInTheDocument()
    resolveFirst({ experiment })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Second candidate' })).toBeInTheDocument())
  })

  it('creates a dataset locally, selects it for the next comparison, and signals the shared refresh', async () => {
    vi.mocked(api).mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/experiments') return { experiments: [] }
      if (path === '/eval/datasets' && options?.method === 'POST') {
        return { dataset: { id: 'dataset-new', name: 'June recoveries', description: 'Accepted samples', exampleCount: 8 } }
      }
      if (path === '/eval/datasets') return { datasets: [] }
      return {}
    })

    render(<ExperimentsPanel />)

    await screen.findByText('No experiments yet')
    fireEvent.change(screen.getByLabelText('Dataset name'), { target: { value: 'June recoveries' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create dataset' }))

    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith('/eval/datasets', expect.objectContaining({ method: 'POST' })))
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
    const experimentWithoutReason = { ...experiment, summaryJson: { ...summary, recommendationReason: undefined } }
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
})
