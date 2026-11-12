import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, ApiError } from '../api'
import type { SessionContext } from '../identity-context'
import { useWorkflowStore } from '../store'
import { AgentClientsPanel, agentClientState } from './AgentClientsPanel'
import { ConfirmProvider } from './ConfirmDialog'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { ...actual, api, contractApi: contractApiOver(api) }
})

const TOKEN = 'jly_agent_first-secret-token-abcd'
const ROTATED = 'jly_agent_second-secret-token-wxyz'

function client(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c-own', name: 'Claude Code', status: 'active', capabilities: ['read', 'propose'],
    scope: { workflowIds: [], tags: ['billing'] }, rateLimitPerMinute: 120, tokenLast4: 'abcd',
    createdBy: 'me', createdAt: '2026-11-01T10:00:00Z', tokenIssuedAt: '2026-11-01T10:00:00Z',
    expiresAt: '2099-12-01T10:00:00Z', revokedAt: null, lastUsedAt: null,
    creatorAccess: { state: 'member', missingPermissions: [] as string[] },
    ...overrides,
  }
}

function listPayload(clients = [client(), client({ id: 'c-peer', name: 'Peer agent', createdBy: 'peer', tokenLast4: 'pppp' })]) {
  return {
    clients,
    nextCursor: null,
    capabilities: [
      { name: 'read', grantable: true, missingPermissions: [] }, { name: 'propose', grantable: true, missingPermissions: [] },
      { name: 'test', grantable: true, missingPermissions: [] }, { name: 'publish', grantable: true, missingPermissions: [] },
      { name: 'operate', grantable: false, missingPermissions: ['dlq.replay', 'recovery.write'] },
      { name: 'report', grantable: true, missingPermissions: [] },
    ],
    limits: { defaultExpiryDays: 30, maxExpiryDays: 90, defaultRateLimitPerMinute: 120, maxRateLimitPerMinute: 600 },
  }
}

function signIn(roleBase: 'editor' | 'admin') {
  const context: SessionContext = {
    identity: { userId: 'me', email: 'me@example.com', mode: 'janusly-session', source: 'sso' },
    profile: { name: null, email: 'me@example.com' },
    organizations: [{ id: 'org', name: 'Org', plan: null, role: roleBase, roleBase, permissions: ['agents.read', 'agents.write'],
      usable: true, developmentFallback: false, isOwner: false }],
    invitations: [], currentOrganizationId: 'org', selectionRequired: false, needsOrganization: false,
    truncated: false, invitationsTruncated: false,
  }
  useWorkflowStore.setState({ identityContext: context })
}

type Route = (path: string, init?: RequestInit) => unknown
function routeApi(routes: Record<string, Route>) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`
    const handler = routes[key]
    if (!handler) throw new Error(`unexpected ${key}`)
    return handler(path, init)
  })
}

function renderPanel(props: Partial<{ canWrite: boolean; canReadMembers: boolean }> = {}) {
  return render(
    <ConfirmProvider>
      <AgentClientsPanel canWrite={props.canWrite ?? true} canReadMembers={props.canReadMembers ?? false} />
    </ConfirmProvider>,
  )
}

describe('<AgentClientsPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    signIn('editor')
  })
  afterEach(() => useWorkflowStore.setState({ identityContext: null }))

  it('lists clients without any token and names the creator', async () => {
    routeApi({ 'GET /v1/agent-clients': () => listPayload() })
    renderPanel()

    const own = await screen.findByTestId('agent-client-c-own')
    expect(within(own).getByText('Claude Code')).toBeInTheDocument()
    expect(within(own).getByText('Propose')).toBeInTheDocument()
    expect(within(own).getByText('#billing')).toBeInTheDocument()
    expect(within(own).getByText('You')).toBeInTheDocument()
    expect(within(own).getByTestId('agent-client-state-c-own')).toHaveTextContent('Active')
    expect(document.body.textContent).not.toContain('jly_agent_')
  })

  it('shows the token once with paste-ready MCP setup and drops it on close', async () => {
    const posted: unknown[] = []
    routeApi({
      'GET /v1/agent-clients': () => listPayload([]),
      'GET /workflows': () => [],
      'POST /v1/agent-clients': (_path, init) => {
        posted.push(JSON.parse(String(init?.body)))
        return { client: client({ id: 'c-new', name: 'Codex', capabilities: ['read', 'test'] }), token: TOKEN }
      },
    })
    renderPanel()

    fireEvent.click(await screen.findByTestId('agent-client-new'))
    const dialog = await screen.findByRole('dialog', { name: 'New agent client' })
    expect(within(dialog).getByLabelText(/Operate/)).toBeDisabled()
    expect(within(dialog).getByTestId('agent-client-missing-operate')).toHaveTextContent('Needs dlq.replay, recovery.write')
    expect(within(dialog).getByLabelText(/Read/)).toBeChecked()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: '  Codex  ' } })
    fireEvent.click(within(dialog).getByLabelText(/Test/))
    fireEvent.change(within(dialog).getByLabelText('Tags'), { target: { value: 'billing, , billing, ops' } })
    fireEvent.click(within(dialog).getByTestId('agent-client-create-submit'))

    const tokenDialog = await screen.findByRole('dialog', { name: 'Codex is ready' })
    expect(posted).toEqual([{
      name: 'Codex', capabilities: ['read', 'test'], scope: { workflowIds: [], tags: ['billing', 'ops'] },
      expiresInDays: 30, rateLimitPerMinute: 120,
    }])
    expect(within(tokenDialog).getByTestId('agent-token-value')).toHaveValue(TOKEN)
    const url = `${window.location.origin}/mcp`
    expect(tokenDialog.textContent).toContain(`claude mcp add --transport http janusly ${url} --header "Authorization: Bearer ${TOKEN}"`)
    expect(tokenDialog.textContent).toContain(`url = "${url}"`)
    expect(tokenDialog.textContent).toContain(`"Authorization" = "Bearer ${TOKEN}"`)
    await waitFor(() => expect(within(tokenDialog).getByTestId('agent-token-done')).toHaveFocus())

    fireEvent.click(within(tokenDialog).getByTestId('agent-token-done'))
    expect(within(tokenDialog).getByTestId('agent-token-confirm')).toHaveTextContent("You won't see this token again.")
    await waitFor(() => expect(within(tokenDialog).getByTestId('agent-token-keep')).toHaveFocus())
    fireEvent.click(within(tokenDialog).getByTestId('agent-token-keep'))
    expect(within(tokenDialog).getByTestId('agent-token-value')).toHaveValue(TOKEN)
    await waitFor(() => expect(within(tokenDialog).getByTestId('agent-token-done')).toHaveFocus())

    fireEvent.click(within(tokenDialog).getByTestId('agent-token-done'))
    fireEvent.click(within(tokenDialog).getByTestId('agent-token-close'))
    expect(screen.queryByTestId('agent-token-dialog')).not.toBeInTheDocument()
    expect(document.documentElement.outerHTML).not.toContain(TOKEN)
    expect(JSON.stringify(useWorkflowStore.getState())).not.toContain(TOKEN)
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN)
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(TOKEN)
    await waitFor(() => expect(screen.getByTestId('agent-client-new')).toHaveFocus())
  })

  it('keeps the create dialog open and shows the server refusal', async () => {
    routeApi({
      'GET /v1/agent-clients': () => listPayload([]),
      'GET /workflows': () => [],
      'POST /v1/agent-clients': () => {
        throw new ApiError('no', { code: 'capability_exceeds_grant', statusCode: 400 })
      },
    })
    renderPanel()
    fireEvent.click(await screen.findByTestId('agent-client-new'))
    const dialog = await screen.findByRole('dialog', { name: 'New agent client' })
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Codex' } })
    fireEvent.click(within(dialog).getByTestId('agent-client-create-submit'))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("You can't give an agent permissions you don't have")
    expect(screen.queryByTestId('agent-token-dialog')).not.toBeInTheDocument()
  })

  it('offers rotate only to the creator and shows the new token once', async () => {
    const rotated: string[] = []
    routeApi({
      'GET /v1/agent-clients': () => listPayload(),
      'POST /v1/agent-clients/c-own/rotate': (path) => {
        rotated.push(path)
        return { client: client(), token: ROTATED }
      },
    })
    renderPanel()

    const peer = await screen.findByTestId('agent-client-c-peer')
    expect(within(peer).queryByRole('button', { name: /Rotate/ })).not.toBeInTheDocument()
    expect(within(peer).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument()

    fireEvent.click(within(screen.getByTestId('agent-client-c-own')).getByRole('button', { name: 'Rotate the token for Claude Code' }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('The token ending in abcd stops working right away.')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Rotate' }))

    const tokenDialog = await screen.findByRole('dialog', { name: 'New token for Claude Code' })
    expect(rotated).toEqual(['/v1/agent-clients/c-own/rotate'])
    expect(within(tokenDialog).getByTestId('agent-token-value')).toHaveValue(ROTATED)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(within(tokenDialog).getByTestId('agent-token-confirm')).toBeInTheDocument()
    fireEvent.click(within(tokenDialog).getByTestId('agent-token-close'))
    await waitFor(() => expect(document.body.textContent).not.toContain(ROTATED))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate the token for Claude Code' })).toHaveFocus())
  })

  it('asks before revoking and lets an admin revoke any client', async () => {
    signIn('admin')
    const revoked: string[] = []
    routeApi({
      'GET /v1/agent-clients': () => listPayload(),
      'POST /v1/agent-clients/c-peer/revoke': (path) => {
        revoked.push(path)
        return { client: client({ id: 'c-peer', name: 'Peer agent', createdBy: 'peer', status: 'revoked', revokedAt: '2026-11-07T10:00:00Z' }) }
      },
    })
    renderPanel()

    const peer = await screen.findByTestId('agent-client-c-peer')
    expect(within(peer).queryByRole('button', { name: /Rotate/ })).not.toBeInTheDocument()
    fireEvent.click(within(peer).getByRole('button', { name: 'Revoke Peer agent' }))
    let confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('The token ending in pppp stops working on its next call, and every agent using it loses Read, Propose.')
    await waitFor(() => expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus())
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(revoked).toEqual([])

    fireEvent.click(within(peer).getByRole('button', { name: 'Revoke Peer agent' }))
    confirm = await screen.findByRole('alertdialog')
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }))
    })
    await waitFor(() => expect(revoked).toEqual(['/v1/agent-clients/c-peer/revoke']))
  })

  it('renders forbidden, error with retry, and empty states', async () => {
    routeApi({ 'GET /v1/agent-clients': () => { throw new ApiError('Forbidden', { statusCode: 403 }) } })
    const { unmount } = renderPanel()
    expect(await screen.findByTestId('agent-clients-forbidden')).toHaveTextContent("You can't see agent clients")
    unmount()

    let calls = 0
    routeApi({
      'GET /v1/agent-clients': () => {
        calls += 1
        if (calls === 1) throw new ApiError('boom', { statusCode: 500 })
        return listPayload([])
      },
    })
    renderPanel({ canWrite: false })
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('agent-clients-empty')).toHaveTextContent('No agent clients')
    expect(screen.queryByTestId('agent-client-new')).not.toBeInTheDocument()
  })
  it.each([
    ['active', {}, 'Active'],
    ['expiring', { expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }, 'Expires soon'],
    ['expired', { status: 'expired' }, 'Expired'],
    ['revoked', { status: 'revoked', revokedAt: '2026-11-02T10:00:00Z' }, 'Revoked'],
    ['removed', { creatorAccess: { state: 'removed', missingPermissions: [] } }, 'No owner'],
    ['reduced', { creatorAccess: { state: 'reduced', missingPermissions: ['workflows.write'] } }, 'Reduced permissions'],
  ] as const)('shows the %s state in text and icon', async (state, overrides, label) => {
    expect(agentClientState(client(overrides) as never)).toBe(state)
    routeApi({ 'GET /v1/agent-clients': () => listPayload([client(overrides)]) })
    renderPanel()
    const row = await screen.findByTestId('agent-client-c-own')
    const pill = within(row).getByTestId('agent-client-state-c-own')
    expect(pill).toHaveTextContent(label)
    expect(pill.querySelector('svg')).not.toBeNull()
    expect(row.getAttribute('data-dimmed') === 'true').toBe(state === 'expired' || state === 'revoked')
    if (state === 'expired' || state === 'revoked') {
      expect(within(row).queryByRole('button', { name: /Rotate/ })).not.toBeInTheDocument()
    }
  })

  it('opens the detail with tools, what the creator lost, latest calls and open requests', async () => {
    routeApi({
      'GET /v1/agent-clients': () => listPayload([client({ creatorAccess: { state: 'reduced', missingPermissions: ['workflows.write'] } })]),
      'GET /v1/agent-clients/c-own': () => ({
        client: client({ creatorAccess: { state: 'reduced', missingPermissions: ['workflows.write'] } }),
        capabilities: [
          { name: 'read', tools: ['runs.list', 'workflows.get'], missingPermissions: [] },
          { name: 'propose', tools: ['drafts.save'], missingPermissions: ['workflows.write'] },
        ],
        recentCalls: [
          { tool: 'workflows.get', allowed: true, at: '2026-11-07T10:00:00Z' },
          { tool: 'drafts.save', allowed: false, at: '2026-11-07T09:00:00Z' },
        ],
        openRequests: [{ id: 'pub-1', workflowId: 'wf-invoices', reasons: ['writes'], createdAt: '2026-11-07T08:00:00Z', expiresAt: '2026-11-08T08:00:00Z' }],
      }),
    })
    renderPanel()
    const toggle = await screen.findByTestId('agent-client-open-c-own')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    const detail = await screen.findByTestId('agent-client-detail-c-own')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(detail).toHaveTextContent('runs.list · workflows.get')
    expect(within(detail).getByTestId('agent-client-lost-propose')).toHaveTextContent('Creator lost workflows.write')
    expect(within(detail).getByRole('img', { name: 'Denied' })).toBeInTheDocument()
    expect(detail).toHaveTextContent('wf-invoices')
  })
  it('hides the calls and requests the viewer could not read elsewhere', async () => {
    routeApi({
      'GET /v1/agent-clients': () => listPayload([client({ createdBy: 'peer' })]),
      'GET /v1/agent-clients/c-own': () => ({
        client: client({ createdBy: 'peer' }),
        capabilities: [{ name: 'read', tools: ['runs.list'], missingPermissions: [] }],
        recentCalls: null,
        openRequests: null,
      }),
    })
    renderPanel()
    fireEvent.click(await screen.findByTestId('agent-client-open-c-own'))
    const detail = await screen.findByTestId('agent-client-detail-c-own')
    expect(detail).toHaveTextContent('runs.list')
    expect(within(detail).queryByText('Latest calls')).not.toBeInTheDocument()
    expect(within(detail).queryByText('Open publish requests')).not.toBeInTheDocument()
  })

  it('blocks creating when the person cannot grant read, which every client gets', async () => {
    const payload = listPayload([])
    payload.capabilities = payload.capabilities.map((capability) => capability.name === 'read'
      ? { ...capability, grantable: false, missingPermissions: ['recovery.read'] }
      : capability)
    routeApi({ 'GET /v1/agent-clients': () => payload, 'GET /workflows': () => [] })
    renderPanel()
    fireEvent.click(await screen.findByTestId('agent-client-new'))
    const dialog = await screen.findByRole('dialog', { name: 'New agent client' })
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Codex' } })
    expect(within(dialog).getByTestId('agent-client-missing-read')).toHaveTextContent('Needs recovery.read')
    expect(within(dialog).getByTestId('agent-client-create-submit')).toBeDisabled()
  })

  it('offers no writes to a viewer-ranked role even with agents.write', async () => {
    const context = useWorkflowStore.getState().identityContext
    useWorkflowStore.setState({ identityContext: context && {
      ...context, organizations: context.organizations.map((org) => ({ ...org, role: 'viewer', roleBase: 'viewer' })),
    } })
    routeApi({ 'GET /v1/agent-clients': () => listPayload() })
    renderPanel({ canWrite: true })
    const own = await screen.findByTestId('agent-client-c-own')
    expect(within(own).queryByRole('button', { name: /Rotate|Revoke/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-client-new')).not.toBeInTheDocument()
  })
})
