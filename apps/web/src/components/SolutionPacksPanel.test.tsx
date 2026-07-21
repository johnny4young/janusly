import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Credential, SolutionPackPublic } from '../types'
import { SolutionPacksPanel } from './SolutionPacksPanel'

const PACK: SolutionPackPublic = {
  id: 'incident-triage',
  name: 'Incident triage',
  description: 'Classify an alert and notify responders.',
  category: 'incident_triage',
  version: '1.0.0',
  requiredCredentials: [
    { name: 'ops_slack', kind: 'slack_webhook', purpose: 'Pages your on-call channel' },
  ],
  requiredOrgConfigs: [],
  nodeCount: 4,
  sampleCount: 1,
  failureCount: 2,
  samplePayloadIds: ['default'],
  failureFixtureIds: ['slack_5xx_transient', 'classification_output_invalid'],
  failureFixtures: [
    {
      id: 'slack_5xx_transient',
      label: 'Slack page returned HTTP 500',
      description: 'The notification provider is temporarily unavailable.',
      failureMode: 'upstream_unavailable',
    },
    {
      id: 'classification_output_invalid',
      label: 'AI severity output malformed',
      description: 'The model output does not satisfy the severity contract.',
      failureMode: 'ai_output_invalid',
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

    const select = screen.getByLabelText('Failure scenario')
    expect(select).toHaveValue('slack_5xx_transient')
    expect(screen.getByText('The on-call notification provider is temporarily unavailable after the incident issue is created.')).toBeVisible()

    fireEvent.change(select, { target: { value: 'classification_output_invalid' } })
    expect(screen.getByText('Invalid AI output')).toBeVisible()
    expect(screen.getByText('The model returns text outside the expected severity contract and the classification step fails safely.')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Start recovery drill' }))
    expect(handlers.onInjectFailure).toHaveBeenCalledWith('incident-triage', 'classification_output_invalid')
  })
})
