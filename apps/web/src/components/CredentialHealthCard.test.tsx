import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { CredentialHealthCard } from './CredentialHealthCard'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const initialState = useWorkflowStore.getState()

describe('<CredentialHealthCard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0 }, true)
  })

  it('renders the healthy state when all credentials resolve and no MCP is stale', async () => {
    vi.mocked(api).mockResolvedValue({
      credentials: [
        {
          id: 'c1',
          name: 'slack-prod',
          kind: 'slack_webhook',
          secretRefPresent: true,
          lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
          lastErrorAt: null,
          lastErrorMessage: null,
          usageCount30d: 5,
          referencingWorkflowIds: ['wf-1'],
        },
      ],
      mcpConnections: [],
      generatedAt: new Date().toISOString(),
    })
    render(<CredentialHealthCard />)
    expect(await screen.findByText('slack-prod')).toBeInTheDocument()
    expect(screen.getByText('Healthy')).toBeInTheDocument()
  })

  it('paints the unhealthy state when secretRefPresent is false and never echoes an env-var-shaped name', async () => {
    vi.mocked(api).mockResolvedValue({
      credentials: [
        {
          id: 'c1',
          name: 'github-bot',
          kind: 'github_token',
          secretRefPresent: false,
          lastUsedAt: null,
          lastErrorAt: null,
          lastErrorMessage: null,
          usageCount30d: 0,
          referencingWorkflowIds: ['wf-a', 'wf-b'],
        },
      ],
      mcpConnections: [],
      generatedAt: new Date().toISOString(),
    })
    render(<CredentialHealthCard />)
    expect(await screen.findByText('github-bot')).toBeInTheDocument()
    expect(screen.getByText('Secret missing')).toBeInTheDocument()
    expect(screen.getByText(/Used by 2 workflows/i)).toBeInTheDocument()
    // The card MUST NOT echo the literal env-var name in any case. The
    // server already redacts it; this is a defense-in-depth smoke that
    // the test fixture's invented env-var name never appears.
    expect(document.body.textContent).not.toContain('GITHUB_BOT_TOKEN')
  })

  it('paints the warn state for MCP connections that are stale or have missing env refs', async () => {
    vi.mocked(api).mockResolvedValue({
      credentials: [],
      mcpConnections: [
        {
          alias: 'notion-prod',
          status: 'active',
          statusReason: null,
          lastDiscoveryAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
          staleDays: 14,
          toolCount: 6,
          enabledToolCount: 4,
          lastUsedAt: null,
          envRefsMissingKeys: [],
          referencingWorkflowIds: ['wf-1', 'wf-2'],
        },
      ],
      generatedAt: new Date().toISOString(),
    })
    render(<CredentialHealthCard />)
    expect(await screen.findByText('notion-prod')).toBeInTheDocument()
    expect(screen.getByText('Discovery stale')).toBeInTheDocument()
    expect(screen.getByText(/Open the MCP connections panel/i)).toBeInTheDocument()
    // The new tools-summary key is rendered via t() (no raw `tools`
    // literal in JSX). The interpolation uses {{enabled}}/{{total}}.
    expect(screen.getByText(/4\/6 tools enabled/i)).toBeInTheDocument()
  })

  it('renders the unavailable banner when the fetch fails (observability is non-load-bearing)', async () => {
    vi.mocked(api).mockRejectedValue(new Error('forbidden'))
    render(<CredentialHealthCard />)
    await waitFor(() => {
      expect(screen.getByText(/Credential health unavailable — forbidden/i)).toBeInTheDocument()
    })
  })
})
