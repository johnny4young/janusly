import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

vi.mock('../store', () => ({
  useWorkflowStore: vi.fn((selector?: (s: { platformVersion: number }) => unknown) => {
    if (typeof selector === 'function') return selector({ platformVersion: 1 })
    return { platformVersion: 1 }
  }),
}))

import { api } from '../api'
import { WorkflowAboutCard } from './WorkflowAboutCard'

const apiMock = vi.mocked(api)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => cleanup())

describe('WorkflowAboutCard', () => {
  it('renders null when workflowId is null', () => {
    const { container } = render(<WorkflowAboutCard workflowId={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the empty-state CTA when the server returns null metadata', async () => {
    apiMock.mockResolvedValueOnce({ workflowId: 'wf-1', metadata: null })
    const { getByTestId, container } = render(<WorkflowAboutCard workflowId="wf-1" />)
    await waitFor(() => {
      const card = getByTestId('workflow-about-card')
      expect(card.className).toContain('we-workflow-about-card--empty')
    })
    expect(container.textContent).toContain('No workflow metadata yet')
  })

  it('renders owners, severity, slack channel, linear, and runbook when present', async () => {
    apiMock.mockResolvedValueOnce({
      workflowId: 'wf-1',
      metadata: {
        workflowId: 'wf-1',
        owners: ['alice', 'bob'],
        runbookMarkdown: '# Payouts\n\n1. Step one\n\nSee [Linear](https://linear.app/acme/payouts).',
        description: 'Daily ACH batch',
        tags: ['billing', 'critical'],
        slackChannel: '#payouts-alerts',
        linearProject: 'acme/payouts',
        severityDefault: 'p1',
        createdBy: 'alice',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
      },
    })
    const { getByTestId, queryByTestId } = render(<WorkflowAboutCard workflowId="wf-1" />)
    await waitFor(() => getByTestId('workflow-about-card-owners'))
    // Localized severity label (consistent with RecoveryItemBadge), not the raw code.
    expect(getByTestId('workflow-about-card-severity').textContent).toBe('P1 — critical')
    expect(getByTestId('workflow-about-card-slack').textContent).toContain('#payouts-alerts')
    expect(getByTestId('workflow-about-card-linear').textContent).toContain('acme/payouts')
    expect(getByTestId('workflow-about-card-runbook')).not.toBeNull()
    // The Linear deep-link should resolve to a linear.app URL.
    const linearAnchor = getByTestId('workflow-about-card-linear').querySelector('a')
    expect(linearAnchor?.getAttribute('href')).toBe('https://linear.app/acme/payouts')
    expect(queryByTestId('workflow-about-card')?.className).not.toContain('--empty')
  })

  it('renders the load-error state when the API rejects', async () => {
    apiMock.mockRejectedValueOnce(new Error('boom'))
    const { getByTestId } = render(<WorkflowAboutCard workflowId="wf-1" />)
    await waitFor(() => {
      const card = getByTestId('workflow-about-card')
      expect(card.className).toContain('we-workflow-about-card--error')
    })
  })
})
