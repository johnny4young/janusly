import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Credential, SolutionPackPublic } from '../types'
import { SolutionPacksPanel } from './SolutionPacksPanel'

const PACK: SolutionPackPublic = {
  id: 'incident-triage',
  name: 'Incident triage',
  description: 'Classify an alert and notify responders.',
  category: 'incident_triage',
  version: '1.2.0',
  assurance: {
    intentContract: true,
    recoveryContractVersion: '2',
    qualificationFixtureCount: 2,
  },
  requiredCredentials: [
    { name: 'ops_slack', kind: 'slack_webhook', purpose: 'Pages your on-call channel' },
  ],
  requiredOrgConfigs: [],
  nodeCount: 4,
  sampleCount: 1,
  failureCount: 2,
  samplePayloadIds: ['default'],
  failureFixtureIds: ['github_secret_unbound', 'worker_interrupted_during_page'],
  failureFixtures: [
    {
      id: 'github_secret_unbound',
      label: 'GitHub credential unavailable',
      description: 'The issue node crosses the real worker boundary before a safe missing-secret probe fails.',
      failureMode: 'credential_unavailable',
      recoveryPath: 'runtime_failure',
    },
    {
      id: 'worker_interrupted_during_page',
      label: 'Worker interrupted during on-call page',
      description: 'A stale running claim crosses the configured threshold.',
      failureMode: 'worker_stalled',
      recoveryPath: 'stalled_node_reaper',
    },
  ],
}

const handlers = {
  onInstall: vi.fn(),
  onSampleRun: vi.fn(),
  onInjectFailure: vi.fn(),
}

function renderPanel(credentials: Credential[]) {
  return render(
    <SolutionPacksPanel
      packs={[PACK]}
      credentials={credentials}
      onInstall={handlers.onInstall}
      onSampleRun={handlers.onSampleRun}
      onInjectFailure={handlers.onInjectFailure}
    />,
  )
}

describe('<SolutionPacksPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('treats a credential as present only when both kind and name match', () => {
    const { container, rerender } = renderPanel([
      { id: 'cred-1', name: 'ops_slack', kind: 'github_token' },
    ])

    const wrongKindChip = screen.getByText('ops_slack').closest('.we-param')
    expect(wrongKindChip).toHaveClass('we-param--missing')
    expect(wrongKindChip).toHaveAccessibleName('ops_slack missing (slack_webhook)')

    rerender(
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={[{ id: 'cred-2', name: 'ops_slack', kind: 'slack_webhook' }]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
      />,
    )

    const matchingChip = container.querySelector('.we-param')
    expect(matchingChip).toHaveClass('we-param--optional')
    expect(matchingChip).toHaveAccessibleName('ops_slack configured (slack_webhook)')
  })

  it('shows the executable assurance included with a qualified pack', () => {
    renderPanel([])

    const assurance = screen.getByTestId('pack-assurance-incident-triage')
    expect(assurance).toHaveAccessibleName('Executable assurance included')
    expect(assurance).toHaveTextContent('Intent contract')
    expect(assurance).toHaveTextContent('Recovery V2')
    expect(assurance).toHaveTextContent('2 qualification fixtures')
  })

  it('filters out non-matching packs and offers clear-filter', () => {
    renderPanel([{ id: 'cred-2', name: 'ops_slack', kind: 'slack_webhook' }])
    expect(screen.getByText('ops_slack')).toBeInTheDocument()

    const input = screen.getByPlaceholderText('Search packs…')
    fireEvent.change(input, { target: { value: 'zzz-no-match' } })
    expect(screen.getByText('No packs match')).toBeInTheDocument()
    expect(screen.queryByText('ops_slack')).not.toBeInTheDocument()
    expect(screen.getByTestId('empty-state-cta')).toHaveTextContent('Clear filter')
  })

  it('shows an explore-templates CTA when the catalog is empty', () => {
    render(
      <SolutionPacksPanel
        packs={[]}
        credentials={[]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
      />,
    )
    expect(screen.getByTestId('empty-state-cta')).toHaveTextContent('Explore templates')
  })

  it('explains the selected drill and sends its explicit fixture id', () => {
    renderPanel([])

    expect(screen.getByTestId('solution-pack-incident-triage')).toBeVisible()
    const select = screen.getByLabelText('Failure scenario')
    expect(select).toHaveValue('github_secret_unbound')
    expect(screen.getByText('Credential unavailable')).toBeVisible()
    expect(screen.getByText('Real runtime path')).toBeVisible()
    expect(screen.getByText(/terminal and non-retryable before sending any request/)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Start recovery drill' }))
    expect(handlers.onInjectFailure).toHaveBeenCalledWith('incident-triage', 'github_secret_unbound')
  })

  it('identifies the real stalled-node reaper path before starting it', () => {
    renderPanel([])

    fireEvent.change(screen.getByLabelText('Failure scenario'), {
      target: { value: 'worker_interrupted_during_page' },
    })

    expect(screen.getByText('Worker interrupted')).toBeVisible()
    expect(screen.getByText('Real reaper path')).toBeVisible()
    expect(screen.getByText(/controlled stale running claim/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Start recovery drill' }))
    expect(handlers.onInjectFailure).toHaveBeenCalledWith(
      'incident-triage',
      'worker_interrupted_during_page',
    )
  })
})
