import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
  failureCount: 1,
  samplePayloadIds: ['default'],
  failureFixtureIds: ['slack_5xx_transient'],
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
})
